// The guest demo, as the browser sees it. Pure, so every sentence a visitor reads here is tested without a browser.
//
// A guest is a visitor who clicked "Try the demo": no password, a private sandbox that is deleted when they leave, and model answers
// replayed from a recorded real run. The words below say exactly that, and no more.

/** What the server reports about a guest's session. */
export type GuestInfo = {
  /** When the sandbox is deleted if the guest does nothing. */
  expiresAt: string;
  /** The date of the recorded run the answers come from, and which model gave them. */
  recordedAt: string;
  model: string;
  /** Which of the runs it was, as the recording words it: "1 of 3 (the first of three repeats ...)". */
  run: string;
  idleMinutes: number;
  maxMinutes: number;
};

/** The hint on anything only the owner may do. */
export const NOT_IN_GUEST_DEMO = 'Not available in the guest demo';

/** "1 of 3 (the first of three repeats...)" becomes "1 of 3 runs". */
export function runLabel(run: string): string {
  const match = /^(\d+) of (\d+)/.exec(run);
  return match ? `${match[1]} of ${match[2]} runs` : run;
}

/** The sentence that is always on screen in guest mode. */
export function bannerText(info: GuestInfo): string {
  return (
    'Guest demo — your changes are private and disappear when you leave. ' +
    `Model answers are replayed from a recorded real run of ${info.model} (${info.recordedAt}, ${runLabel(info.run)}). ` +
    'Nothing is ever sent.'
  );
}

/** Milliseconds left before the sandbox is deleted, never negative. */
export function timeLeftMs(expiresAt: string, nowMs: number): number {
  const end = Date.parse(expiresAt);
  return Number.isNaN(end) ? 0 : Math.max(0, end - nowMs);
}

/** "27 min", "1 h 5 min", "under a minute": what is left, in words, to the minute. */
export function formatTimeLeft(ms: number): string {
  if (ms < 60_000) return 'under a minute';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** The line beside the countdown. It resets if the guest does nothing; any activity restarts the idle part of it. */
export function resetNote(info: GuestInfo, nowMs: number): string {
  return `Resets in ${formatTimeLeft(timeLeftMs(info.expiresAt, nowMs))} if you stop (idle limit ${info.idleMinutes} min, longest ${info.maxMinutes / 60} h).`;
}

/** What "Analyse again" says in the guest demo: nothing new is asked of anything. */
export const GUEST_REANALYSE = 'Analyse again (replays the same recorded answer)';

/** The note under the analyse button in the guest demo: the cost is nothing, and the answers are recorded. */
export function guestAnalyseNote(waiting: number): string | null {
  if (waiting === 0) return null;
  return `Reads ${waiting === 1 ? 'the 1 waiting email' : `all ${waiting} waiting emails`} in one go, using the recorded answers. No model is called.`;
}

/** Whether the sign-in page offers the guest demo: only to a visitor, and only if the server has it on. */
export function showGuestButton(status: string, guestDemoEnabled: boolean): boolean {
  return status === 'anonymous' && guestDemoEnabled;
}

/** What to tell a visitor when the guest demo could not be started. */
export function guestStartError(status: number, serverMessage: string | null): string {
  if (status === 503) return serverMessage ?? 'The demo is busy — try again in a few minutes.';
  if (status === 429) return 'Too many demo sessions have been started from your network. Try again later.';
  if (status === 409) return 'You are signed in as the owner. Sign out first to try the guest demo.';
  if (status === 403) return 'The guest demo is turned off on this server.';
  return 'Could not start the demo. Check your connection and try again.';
}

/** An actor, as a person reads it. A person actor with the id `guest` is "Guest". */
export function actorWho(actor: string, actorId: string | null): string {
  if (actor === 'human' && actorId === 'guest') return 'Guest';
  if (actor === 'human') return actorId ? `Person · ${actorId}` : 'Person';
  if (actor === 'ai') return 'Assistant';
  if (actor === 'system') return 'System';
  return actor;
}
