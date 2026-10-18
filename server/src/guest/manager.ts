import { randomBytes } from 'node:crypto';
import { createSessionToken, hashSessionToken } from '../domain/session.ts';
import { AppError } from '../lib/errors.ts';
import type { Clock } from '../lib/clock.ts';
import { createSandbox, type Sandbox, type SandboxBuildDeps } from './sandbox.ts';

// The guest sandboxes: how many exist, who may start one, and when they are deleted.
//
// LIMITS (each an explicit number, none of them hidden in a constant elsewhere)
//
//   maxSandboxes     20 at once. Past that, "The demo is busy".
//   perIpPerHour      5 new guest sessions per address per hour.
//   idleMs           30 minutes without a request ends a sandbox.
//   maxAgeMs          2 hours is the longest any sandbox lives, active or not.
//
// A sandbox is deleted on sign-out, when it has been idle too long, or when it is too old, whichever comes first. A sweep runs on a
// timer and once at start. Time comes from an injected clock so the tests can move it.

export type GuestLimits = {
  maxSandboxes: number;
  perIpPerHour: number;
  idleMs: number;
  maxAgeMs: number;
};

export const DEFAULT_GUEST_LIMITS: GuestLimits = {
  maxSandboxes: 20,
  perIpPerHour: 5,
  idleMs: 30 * 60_000,
  maxAgeMs: 2 * 3_600_000,
};

const HOUR_MS = 3_600_000;

export type GuestManagerOptions = {
  build: SandboxBuildDeps;
  limits?: Partial<GuestLimits>;
  clock?: Clock;
};

export type StartedGuest = { token: string; sandbox: Sandbox };

export class GuestManager {
  readonly limits: GuestLimits;
  private readonly clock: Clock;
  private readonly build: SandboxBuildDeps;
  private readonly sandboxes = new Map<string, Sandbox>();
  private readonly starts = new Map<string, number[]>();
  private timer: NodeJS.Timeout | null = null;

  constructor(options: GuestManagerOptions) {
    this.limits = { ...DEFAULT_GUEST_LIMITS, ...options.limits };
    this.clock = options.clock ?? options.build.clock;
    this.build = { ...options.build, clock: this.clock };
  }

  private nowMs(): number {
    return Date.parse(this.clock.nowIso());
  }

  get size(): number {
    return this.sandboxes.size;
  }

  /** When this sandbox will be deleted if the guest does nothing: the sooner of the idle limit and the age limit. */
  expiresAt(sandbox: Sandbox): string {
    const idleEnd = Date.parse(sandbox.lastSeenAt) + this.limits.idleMs;
    const ageEnd = Date.parse(sandbox.createdAt) + this.limits.maxAgeMs;
    return new Date(Math.min(idleEnd, ageEnd)).toISOString();
  }

  private recentStarts(ip: string, now: number): number[] {
    const recent = (this.starts.get(ip) ?? []).filter((at) => now - at < HOUR_MS);
    if (recent.length === 0) this.starts.delete(ip);
    else this.starts.set(ip, recent);
    return recent;
  }

  /**
   * Opens a sandbox for a visitor. The token is returned once, to be set as a cookie; only its hash is kept.
   *
   * Refused when this address has started too many in the past hour, or when the demo is full. A refused attempt creates nothing.
   */
  async start(ip: string): Promise<StartedGuest> {
    await this.sweep();
    const now = this.nowMs();

    const recent = this.recentStarts(ip, now);
    if (recent.length >= this.limits.perIpPerHour) {
      const oldest = Math.min(...recent);
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + HOUR_MS - now) / 1000));
      throw new AppError('RATE_LIMITED', 'Too many demo sessions have been started from your network. Try again later.', {
        details: { retryAfterSeconds },
      });
    }
    if (this.sandboxes.size >= this.limits.maxSandboxes) {
      throw new AppError('SERVICE_BUSY', 'The demo is busy — try again in a few minutes.');
    }

    const token = createSessionToken();
    const sandbox = await createSandbox(this.build, {
      id: randomBytes(8).toString('hex'),
      tokenHash: hashSessionToken(token),
      csrfToken: createSessionToken(),
      ip,
    });
    this.sandboxes.set(sandbox.tokenHash, sandbox);
    this.starts.set(ip, [...recent, now]);
    return { token, sandbox };
  }

  /** The sandbox a token belongs to, or null. An expired one is deleted rather than returned. */
  async lookup(token: string | null): Promise<Sandbox | null> {
    if (!token) return null;
    const sandbox = this.sandboxes.get(hashSessionToken(token)) ?? null;
    if (!sandbox) return null;
    if (this.isExpired(sandbox)) {
      await this.remove(sandbox);
      return null;
    }
    return sandbox;
  }

  /** Marks activity. The idle clock restarts; the age limit does not. */
  touch(sandbox: Sandbox): void {
    sandbox.lastSeenAt = this.clock.nowIso();
  }

  async reset(sandbox: Sandbox): Promise<void> {
    await sandbox.reset();
    this.touch(sandbox);
  }

  /** Ends a guest's session and deletes everything it held. Idempotent. */
  async leave(token: string | null): Promise<boolean> {
    if (!token) return false;
    const sandbox = this.sandboxes.get(hashSessionToken(token));
    if (!sandbox) return false;
    await this.remove(sandbox);
    return true;
  }

  private isExpired(sandbox: Sandbox): boolean {
    return Date.parse(this.expiresAt(sandbox)) <= this.nowMs();
  }

  private async remove(sandbox: Sandbox): Promise<void> {
    this.sandboxes.delete(sandbox.tokenHash);
    await sandbox.dispose();
  }

  /** Deletes every sandbox that has been idle too long or lived too long. Returns how many. */
  async sweep(): Promise<number> {
    let removed = 0;
    for (const sandbox of Array.from(this.sandboxes.values())) {
      if (this.isExpired(sandbox)) {
        await this.remove(sandbox);
        removed += 1;
      }
    }
    // Forget addresses whose hour is up, so the table cannot grow without end.
    const now = this.nowMs();
    for (const ip of Array.from(this.starts.keys())) this.recentStarts(ip, now);
    return removed;
  }

  /** Runs the sweep on a timer. The timer never keeps the process alive. */
  startSweeper(intervalMs = 60_000): void {
    this.stopSweeper();
    this.timer = setInterval(() => void this.sweep().catch(() => undefined), intervalMs);
    this.timer.unref();
  }

  stopSweeper(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Deletes everything: used at shutdown. */
  async closeAll(): Promise<void> {
    this.stopSweeper();
    for (const sandbox of Array.from(this.sandboxes.values())) await this.remove(sandbox);
  }
}
