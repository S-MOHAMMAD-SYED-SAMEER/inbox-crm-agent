import { ApiError } from '../api/client.ts';

// Turning a refusal into something a reviewer can act on.
//
// Every way `POST /revise` can say no is a different situation for the person
// at the screen, and flattening them into "something went wrong" wastes the
// work the server did to be specific. A validation error means "fix this
// field"; a guardrail refusal means "that sentence cannot go to a customer"; a
// lifecycle conflict means "reload, this moved on without you".
//
// WHAT NEVER REACHES THE PANEL
//
// The customer's email body. It is on the page already, in the place it
// belongs; repeating it inside a red box is how message content ends up in a
// screenshot in a support ticket. Nor does anything about the server's
// internals — `details` is read for the two keys the API documents, and the
// rest is ignored rather than dumped.

export type ReviseErrorKind = 'validation' | 'guardrail' | 'lifecycle' | 'conflict' | 'network' | 'unknown';

export type ReviseErrorView = {
  kind: ReviseErrorKind;
  /** The headline. Short, and never blaming the reviewer. */
  title: string;
  /** One sentence of context, or null when the title says it all. */
  message: string | null;
  /** Field-level problems, for a validation error. */
  problems: string[];
  /** Guardrail names, for a safety refusal. */
  guardrails: string[];
  /** True when reloading is the sensible next move. */
  stale: boolean;
};

/** `guardrail_name: why it exists` — the shape M4-C.2 sends for a blocked draft. */
const GUARDRAIL_PROBLEM = /^([a-z_]+):\s*(.*)$/;

function readProblems(details: Record<string, unknown>): string[] {
  const problems = details.problems;
  if (!Array.isArray(problems)) return [];
  return problems.filter((problem): problem is string => typeof problem === 'string');
}

export function describeReviseError(error: unknown): ReviseErrorView {
  const base: ReviseErrorView = {
    kind: 'unknown',
    title: 'That could not be saved',
    message: 'Something went wrong. Please try again.',
    problems: [],
    guardrails: [],
    stale: false,
  };

  if (!(error instanceof ApiError)) {
    // A thrown non-ApiError is a transport failure: the client wraps every HTTP
    // response, so anything else got no answer at all.
    return {
      ...base,
      kind: 'network',
      title: 'Could not reach the assistant',
      message: 'Your changes were not saved. Check your connection and try again.',
    };
  }

  if (error.code === 'VALIDATION_ERROR') {
    const problems = readProblems(error.details);
    const guardrails = problems
      .map((problem) => GUARDRAIL_PROBLEM.exec(problem)?.[1])
      .filter((name): name is string => name !== undefined);

    // A guardrail refusal arrives as a validation error whose problems are all
    // named checks. Same envelope, very different thing to tell a person.
    if (guardrails.length > 0 && guardrails.length === problems.length) {
      return {
        ...base,
        kind: 'guardrail',
        title: 'Revision blocked by safety checks.',
        message: 'The reply was not saved. These checks apply to anything the business sends, written by a person or not.',
        guardrails,
      };
    }

    return {
      ...base,
      kind: 'validation',
      title: 'Some changes need another look',
      message: problems.length === 0 ? error.message : null,
      problems,
    };
  }

  if (error.code === 'INVALID_STATE') {
    return {
      ...base,
      kind: 'lifecycle',
      title: 'This proposal moved on',
      message: error.message,
      stale: true,
    };
  }

  if (error.code === 'CONFLICT') {
    return {
      ...base,
      kind: 'conflict',
      title: 'Someone got there first',
      message: error.message,
      stale: true,
    };
  }

  if (error.code === 'NOT_FOUND') {
    return { ...base, kind: 'lifecycle', title: 'That proposal no longer exists', message: error.message, stale: true };
  }

  return base;
}

/**
 * The field a validation problem is about, when it names one.
 *
 * The server quotes the path it rejected (`"edits.draft.subject" must not be
 * empty`), which is enough to put the message under the right control instead
 * of in a list at the bottom of the form.
 */
export function problemPath(problem: string): string | null {
  const quoted = /"([^"]+)"/.exec(problem);
  if (!quoted) return null;

  const path = quoted[1] as string;
  const draft = /^edits\.draft\.(\w+)$/.exec(path);
  if (draft) return `draft.${draft[1]}`;

  const action = /^edits\.actions\[(\d+)\]\.value$/.exec(path);
  if (action) return `actions.${action[1]}`;

  return null;
}
