// Filling a freshly reset demo with the state a visitor needs to see (P19).
//
// WHY THIS EXISTS AT ALL
//
// `demo:reset` deliberately leaves the inbox empty — its own output says so —
// because it was built for an attended demonstration, where the operator signs
// in and ingests live while a client watches. That is the strongest moment in
// the demo and it should not be pre-cooked.
//
// The public read-only demo has no operator. A visitor arriving at an empty
// inbox sees an empty product, and cannot fix it: the ingest control is hidden
// in demo mode and the endpoint refuses them anyway. So the pipeline has to be
// run once, by a person, before the window is opened.
//
// WHAT THIS MODULE IS
//
// The judgement, separated from the I/O for the same reason `demo/reset.ts` is:
// deciding whether a deployment may be populated, and whether the result is
// actually demonstrable, are the parts worth testing. The script that prompts,
// prints and makes HTTP calls holds no decisions of its own.
//
// WHAT IT NEVER DOES
//
// It stops at `decide`. Nothing here approves, executes, retries or sends —
// pending approvals are the point, because "a human authorises anything
// consequential" is the product's central claim and an empty approvals queue
// demonstrates the opposite of it.

/** What the caller asserts it is populating. Nothing is inferred. */
export type PopulateTargetKind = 'local' | 'production';

export const POPULATE_REFUSAL_CODES = [
  'no_target_declared',
  'unreachable',
  'driver_mismatch',
  'provider_not_mock',
  'outbound_enabled',
  'auth_not_configured',
] as const;
export type PopulateRefusalCode = (typeof POPULATE_REFUSAL_CODES)[number];

export type PopulateRefusal = { ok: false; code: PopulateRefusalCode; message: string };

export type PopulatePlan = {
  ok: true;
  kind: PopulateTargetKind;
  driver: string;
  /** True when the read window is already open, so a visitor may be watching. */
  publicWindowOpen: boolean;
};

export type PopulateAssessment = PopulatePlan | PopulateRefusal;

/** The subset of `/api/health` this decision depends on. */
export type HealthSnapshot = {
  status?: string;
  database?: { driver?: string; reachable?: boolean; migrationsApplied?: number };
  adapters?: Record<string, string | boolean | number>;
};

/**
 * Decides whether a deployment may be populated.
 *
 * Reads only, and total: an absent or malformed field is a refusal, never a
 * default. Every gate below refuses in the direction that leaves the
 * deployment untouched.
 */
export function assessPopulate(options: {
  declaredKind: PopulateTargetKind | null;
  health: HealthSnapshot | null;
}): PopulateAssessment {
  const { declaredKind, health } = options;

  // 1. The caller must say what it thinks it is talking to. Same rule as the
  //    reset: a script that guesses its target is one command from the wrong
  //    database.
  if (declaredKind === null) {
    return {
      ok: false,
      code: 'no_target_declared',
      message: 'No target was declared. Pass --local or --production to say which deployment you mean.',
    };
  }

  if (!health || typeof health !== 'object' || health.database?.reachable !== true) {
    return {
      ok: false,
      code: 'unreachable',
      message: 'The deployment did not report a reachable database. Refusing to send it anything.',
    };
  }

  // 2. And be right about it.
  const driver = String(health.database?.driver ?? '');
  const isHosted = driver !== '' && driver !== 'sqlite';

  if (declaredKind === 'production' && !isHosted) {
    return {
      ok: false,
      code: 'driver_mismatch',
      message: `--production was requested but the deployment reports "${driver || 'unknown'}". Refusing.`,
    };
  }
  if (declaredKind === 'local' && isHosted) {
    return {
      ok: false,
      code: 'driver_mismatch',
      message: `--local was requested but the deployment reports "${driver}", which is not a local database. Refusing.`,
    };
  }

  const adapters = health.adapters ?? {};

  // 3. The model must be the deterministic mock.
  //
  //    Two reasons, and either alone is enough. A real provider makes this
  //    non-deterministic, so the demo a visitor sees would differ from the one
  //    that was reviewed. And it spends money per run, which is the operator's
  //    own, on a script whose whole purpose is to be re-runnable.
  if (adapters.llmProvider !== 'mock') {
    return {
      ok: false,
      code: 'provider_not_mock',
      message:
        `The deployment reports llmProvider "${String(adapters.llmProvider)}". ` +
        'Populating would be non-deterministic and would spend real credit. Refusing.',
    };
  }

  // 4. Outbound sending must be off.
  //
  //    THE ONE GATE THAT PROTECTS SOMEBODY OTHER THAN THE OPERATOR.
  //
  //    This script drives the pipeline as far as `decide`, which drafts replies
  //    addressed to the fixture senders. It never approves or executes, so no
  //    draft should ever reach a transport — but "should" is doing load-bearing
  //    work in that sentence, and the cost of being wrong is mail sent to
  //    addresses invented for a demo. A deployment that *can* send is refused
  //    rather than trusted to not be asked to.
  if (adapters.outboundSendEnabled !== false) {
    return {
      ok: false,
      code: 'outbound_enabled',
      message:
        'The deployment reports outbound sending is possible. This script drafts replies, so it will ' +
        'not run anywhere a draft could leave the building. Refusing.',
    };
  }

  // 5. Sign-in must be configured, or there is no way to authorise any of this.
  if (adapters.authConfigured !== true) {
    return {
      ok: false,
      code: 'auth_not_configured',
      message: 'The deployment has no operator password configured, so nothing here can be authorised. Refusing.',
    };
  }

  return {
    ok: true,
    kind: declaredKind,
    driver,
    publicWindowOpen: adapters.demoPublicReadonly === true,
  };
}

/** What the pipeline reported, stage by stage. */
export type PipelineOutcome = {
  ingested: number;
  duplicates: number;
  understood: number;
  understandFailed: number;
  resolved: number;
  resolveConflicts: number;
  resolveFailed: number;
  decided: number;
  decideFailed: number;
  /** Emails visible in the inbox afterwards. */
  emails: number;
  /** Approvals waiting on a person afterwards. */
  pendingApprovals: number;
};

export type PopulationCheck = { ready: boolean; problems: string[] };

/**
 * Whether the result is something worth showing a stranger.
 *
 * Deliberately stricter than "no errors". A run can complete cleanly and still
 * leave a demo that argues against the product — an inbox with nothing in it,
 * or an approvals queue that is empty because everything auto-executed. Both
 * are successes by the pipeline's own reckoning and failures by ours.
 */
export function verifyPopulated(outcome: PipelineOutcome): PopulationCheck {
  const problems: string[] = [];

  if (outcome.emails === 0) {
    problems.push('The inbox is empty, so a visitor would see nothing at all.');
  }
  if (outcome.pendingApprovals === 0) {
    problems.push(
      'No approval is waiting on a person. Human-in-the-loop is what this project demonstrates, ' +
        'and an empty queue shows the opposite.',
    );
  }
  if (outcome.understandFailed > 0) {
    problems.push(`${outcome.understandFailed} email(s) failed the understand stage.`);
  }
  if (outcome.resolveFailed > 0) {
    problems.push(`${outcome.resolveFailed} email(s) failed the resolve stage.`);
  }
  if (outcome.decideFailed > 0) {
    problems.push(`${outcome.decideFailed} email(s) failed the decide stage.`);
  }

  return { ready: problems.length === 0, problems };
}

/**
 * Whether a second run would change anything.
 *
 * Ingestion inserts only messages it has not seen, so a repeat run reports
 * every fixture as a duplicate and ingests none. That is the signal that the
 * script is safe to run again, and it is worth saying out loud rather than
 * leaving the operator to infer it from two numbers.
 */
export function describeIdempotence(outcome: PipelineOutcome): string {
  if (outcome.ingested === 0 && outcome.duplicates > 0) {
    return `Nothing new was ingested; all ${outcome.duplicates} fixture message(s) were already present.`;
  }
  if (outcome.duplicates === 0) {
    return `Ingested ${outcome.ingested} message(s) into an empty inbox.`;
  }
  return `Ingested ${outcome.ingested} new message(s); ${outcome.duplicates} were already present.`;
}
