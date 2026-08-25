import type { RepoDeps } from './crm.ts';
import { toText, toJson, fromJson } from '../rows.ts';
import { AUTONOMY_LEVELS, type AutonomyLevel } from '../../domain/policy.ts';
import { CONFIDENCE_THRESHOLDS } from '../../domain/email.ts';

// Operator settings (§13.9).
//
// A key/value table rather than a wide `settings` row: these values are read
// rarely, written rarely, and change shape as milestones land. A JSON column
// per key means adding a setting is an INSERT, not a migration.
//
// The defaults below are the *code* defaults — what the system does before
// anyone has configured anything. Note `autonomy_level: 'manual'`: a fresh
// install asks a human about everything. Trust is earned with evidence from
// the client's own inbox, so the safe default is also the honest one to demo.

export type SettingsShape = {
  autonomy_level: AutonomyLevel;
  confidence_thresholds: { high: number; medium: number };
  approval_sla_hours: number;
  outbound_send_enabled: boolean;
  business_profile: {
    name: string;
    services: string[];
    tone: string;
    neverPromise: string[];
  };
};

export const DEFAULT_SETTINGS: SettingsShape = {
  autonomy_level: 'manual',
  confidence_thresholds: { high: CONFIDENCE_THRESHOLDS.high, medium: CONFIDENCE_THRESHOLDS.medium },
  approval_sla_hours: 24,
  // Hard-coded false and never read as true by anything in this build. The
  // switch exists so the Settings screen can show it locked with a reason,
  // which is a more honest demo than hiding the capability entirely.
  outbound_send_enabled: false,
  business_profile: {
    name: 'AI Business Automation',
    services: [
      'AI Customer Support & Sales Recovery',
      'Website Modernization & Conversion',
      'Business Workflow Automation',
      'AI Recruitment Intelligence',
      'AI Inbox & Lead Management',
    ],
    tone: 'Direct, concise, and concrete. No hype, no jargon, no over-promising.',
    // Fed to the drafting prompt in M3 and enforced independently by the draft
    // guardrails — the prompt asks, the guardrail checks. A model that ignores
    // the instruction still cannot get a price past the deterministic check.
    neverPromise: [
      'a specific price or quote',
      'a delivery date or timeline',
      'a discount or free work',
      'a guarantee of results',
    ],
  },
};

export function createSettingsRepository({ db, clock }: RepoDeps) {
  return {
    async get<K extends keyof SettingsShape>(key: K): Promise<SettingsShape[K]> {
      const rows = await db.query('SELECT value FROM settings WHERE key = ?', [key]);
      if (!rows[0]) return DEFAULT_SETTINGS[key];
      return toJson<SettingsShape[K]>(rows[0].value, DEFAULT_SETTINGS[key]);
    },

    async getAll(): Promise<SettingsShape> {
      const rows = await db.query<{ key: string; value: unknown }>('SELECT key, value FROM settings');
      const stored: Partial<SettingsShape> = {};
      for (const row of rows) {
        const key = toText(row.key) as keyof SettingsShape;
        if (key in DEFAULT_SETTINGS) {
          // Unknown keys are ignored rather than surfaced: a stale row left by
          // an older build should not break the Settings screen.
          (stored as Record<string, unknown>)[key] = toJson(row.value, DEFAULT_SETTINGS[key]);
        }
      }
      return { ...DEFAULT_SETTINGS, ...stored };
    },

    async set<K extends keyof SettingsShape>(
      key: K,
      value: SettingsShape[K],
      updatedBy = 'system',
    ): Promise<void> {
      const now = clock.nowIso();
      const updated = await db.execute(
        'UPDATE settings SET value = ?, updated_at = ?, updated_by = ? WHERE key = ?',
        [fromJson(value), now, updatedBy, key],
      );
      if (updated.rowCount === 0) {
        await db.execute(
          'INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)',
          [key, fromJson(value), now, updatedBy],
        );
      }
    },

    /** Writes every default that is not already present. Used by the seed script. */
    async seedDefaults(): Promise<void> {
      for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof SettingsShape>) {
        const rows = await db.query('SELECT key FROM settings WHERE key = ?', [key]);
        if (!rows[0]) await this.set(key, DEFAULT_SETTINGS[key], 'seed');
      }
    },
  };
}

export function isAutonomyLevel(value: unknown): value is AutonomyLevel {
  return typeof value === 'string' && (AUTONOMY_LEVELS as readonly string[]).includes(value);
}

export type SettingsRepository = ReturnType<typeof createSettingsRepository>;
