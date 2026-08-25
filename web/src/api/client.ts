import { CSRF_HEADER, currentCsrfToken, needsCsrf, type SessionResponse } from '../auth/session.ts';
import type {
  ApprovalQueueRow,
  AuditRow,
  CompanyRow,
  ContactRow,
  DealRow,
  TaskRow,
  ApprovalState,
  EditEnvelope,
  EmailDetail,
  EmailSummary,
  ErrorEnvelope,
  Health,
  RevisionResult,
} from './types.ts';

export type ExecutionResponse = {
  ok: boolean;
  refusedWith: string | null;
  refusalMessage: string | null;
  executed: number;
  outboxStatus: string | null;
  detail: EmailDetail;
};

// The API client.
//
// One place that knows how to talk to the server, so no component ever calls
// `fetch` directly. Two consequences worth the file:
//
//   * Errors arrive as one type. The server always answers a failure with the
//     same envelope, so the client can turn any failure — including a network
//     drop, which has no envelope at all — into the same `ApiError`. A screen
//     then has exactly one error shape to render.
//   * No secret ever reaches this layer, because there is nothing to send. The
//     browser holds no key and no token: every provider call happens on the
//     server (§19). If this file ever grows an API key, something has gone
//     badly wrong upstream of it.

const BASE_URL = '/api';

// --- authentication events (M6-A) -------------------------------------------
//
// The client cannot navigate, and the app cannot see inside a fetch. These two
// hooks are the seam: the client reports what the server said, and the app
// decides what to show. A module-level subscriber rather than a context because
// exactly one thing subscribes — the session gate in App.tsx — and threading a
// callback through every screen to reach `fetch` would be worse.

type AuthListener = () => void;

let onUnauthorized: AuthListener | null = null;
let onCsrfFailure: AuthListener | null = null;

/** Called when the server says the session is gone. The app returns to Login. */
export function setUnauthorizedHandler(handler: AuthListener | null): void {
  onUnauthorized = handler;
}

/** Called when a state-changing request fails CSRF verification. */
export function setCsrfFailureHandler(handler: AuthListener | null): void {
  onCsrfFailure = handler;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // The CSRF token rides along on every state-changing request (M5-B). It is
  // read from the readable cookie at call time rather than cached, so a fresh
  // sign-in cannot leave a stale token behind. The session cookie itself is
  // HttpOnly and is never touched here — the browser attaches it.
  const csrf = needsCsrf(init?.method) ? currentCsrfToken() : null;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(csrf ? { [CSRF_HEADER]: csrf } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      // Explicit rather than relying on the default. The API is same-origin —
      // the dev proxy makes that true locally too — and this is the line that
      // says the session cookie is meant to travel.
      credentials: 'same-origin',
      // After `...init`, so a caller cannot accidentally drop the content type
      // or the CSRF token by passing its own headers object.
      headers,
    });
  } catch (cause) {
    // A network failure has no envelope, so one is supplied here — otherwise
    // every caller would need a second, different error path for "the server
    // was not reachable at all".
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server.', {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }

  const text = await response.text();
  const parsed: unknown = text === '' ? null : safeParse(text);

  if (!response.ok) {
    const envelope = parsed as ErrorEnvelope | null;
    const error = new ApiError(
      response.status,
      envelope?.error?.code ?? 'INTERNAL_ERROR',
      envelope?.error?.message ?? 'Something went wrong.',
      envelope?.error?.details ?? {},
    );

    // A 401 means the session ended — expired, revoked, or never there. The app
    // is told once and returns to Login; the error still propagates so the
    // caller does not mistake it for an empty result.
    //
    // `/auth/session` is exempt because it answers 200 for anonymous by design,
    // and `/auth/login` because a wrong password is a failed sign-in rather
    // than a lost session. Notifying on either would put the app in a loop
    // between "check the session" and "the session is gone".
    if (error.status === 401 && path !== '/auth/session' && path !== '/auth/login') {
      onUnauthorized?.();
    }

    if (error.status === 403 && error.details.reason === 'csrf_token_invalid') {
      onCsrfFailure?.();
    }

    throw error;
  }

  return parsed as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const api = {
  health: (): Promise<Health> => request<Health>('/health'),

  // --- authentication (M6-A) ------------------------------------------------

  /** The server's answer to "am I signed in?". The only source of that truth. */
  session: (): Promise<SessionResponse> => request<SessionResponse>('/auth/session'),

  /**
   * Signs in.
   *
   * The password is passed straight through to the request body and is never
   * stored, logged or returned. The session and CSRF cookies come back as
   * `Set-Cookie` headers the browser handles; nothing about them is readable
   * from here except the CSRF token, by design.
   *
   * No CSRF token is sent, and none is required: there is no session yet to
   * carry one, which is exactly the exemption M5-B makes for this endpoint.
   */
  login: (password: string): Promise<{ operator: string; expiresAt: string }> =>
    request<{ operator: string; expiresAt: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  /** Signs out. CSRF-protected like any other state change (M5-B). */
  logout: (): Promise<{ signedOut: boolean }> =>
    request<{ signedOut: boolean }>('/auth/logout', { method: 'POST', body: JSON.stringify({}) }),

  // --- CRM (M6-C). Read-only: there is no write counterpart to any of these.
  listDeals: (stage?: string): Promise<{ deals: DealRow[]; total: number }> =>
    request(`/deals${stage ? `?stage=${encodeURIComponent(stage)}` : ''}`),

  listContacts: (): Promise<{ contacts: ContactRow[]; total: number }> => request('/contacts'),

  listCompanies: (): Promise<{ companies: CompanyRow[]; total: number }> => request('/companies'),

  listTasks: (status?: string): Promise<{ tasks: TaskRow[]; total: number }> =>
    request(`/tasks${status ? `?status=${encodeURIComponent(status)}` : ''}`),

  listAudit: (actor?: string): Promise<{ events: AuditRow[]; total: number }> =>
    request(`/audit${actor ? `?actor=${encodeURIComponent(actor)}` : ''}`),

  listEmails: (state?: string): Promise<{ emails: EmailSummary[] }> =>
    request<{ emails: EmailSummary[] }>(`/emails${state ? `?state=${encodeURIComponent(state)}` : ''}`),

  getEmail: (id: string): Promise<EmailDetail> => request<EmailDetail>(`/emails/${encodeURIComponent(id)}`),

  ingest: (): Promise<{ ingested: number; duplicates: number }> =>
    request<{ ingested: number; duplicates: number }>('/emails/ingest', {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  understandPending: (): Promise<{ processed: number; failed: number }> =>
    request<{ processed: number; failed: number }>('/emails/understand', {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  understandEmail: (id: string): Promise<EmailDetail> =>
    request<EmailDetail>(`/emails/${encodeURIComponent(id)}/understand`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  resolvePending: (): Promise<{ resolved: number; conflicts: number; failed: number }> =>
    request<{ resolved: number; conflicts: number; failed: number }>('/emails/resolve', {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  resolveEmail: (id: string): Promise<EmailDetail> =>
    request<EmailDetail>(`/emails/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  /** `entityId: null` means the operator decided this is a new record. */
  listApprovals: (state: ApprovalState = 'pending'): Promise<{ approvals: ApprovalQueueRow[]; counts: Record<string, number> }> =>
    request<{ approvals: ApprovalQueueRow[]; counts: Record<string, number> }>(
      `/approvals?state=${encodeURIComponent(state)}`,
    ),

  expireApprovals: (): Promise<{ expired: number; skipped: number; emails: string[] }> =>
    request<{ expired: number; skipped: number; emails: string[] }>('/approvals/expire', {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  approve: (decisionId: string): Promise<ExecutionResponse> =>
    request<ExecutionResponse>(`/decisions/${encodeURIComponent(decisionId)}/approve`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  /**
   * Creates a revision from a human's edits (M4-C).
   *
   * Grants nothing on its own: the response carries a *pending* approval on a
   * new decision, which still has to go through `approve()`.
   */
  revise: (decisionId: string, edits: EditEnvelope, editedBy?: string): Promise<RevisionResult> =>
    request<RevisionResult>(`/decisions/${encodeURIComponent(decisionId)}/revise`, {
      method: 'POST',
      body: JSON.stringify(editedBy === undefined ? { edits } : { edits, editedBy }),
    }),

  reject: (decisionId: string, reason: string): Promise<EmailDetail> =>
    request<EmailDetail>(`/decisions/${encodeURIComponent(decisionId)}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  /** Runs a plan that needs no approval, or retries a failed one. */
  execute: (decisionId: string): Promise<ExecutionResponse> =>
    request<ExecutionResponse>(`/decisions/${encodeURIComponent(decisionId)}/execute`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  decidePending: (): Promise<{ decided: number; awaitingApproval: number; noPlan: number; failed: number }> =>
    request<{ decided: number; awaitingApproval: number; noPlan: number; failed: number }>('/emails/decide', {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  decideEmail: (id: string): Promise<EmailDetail> =>
    request<EmailDetail>(`/emails/${encodeURIComponent(id)}/decide`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  resolveMatch: (id: string, entityType: 'contact' | 'company', entityId: string | null): Promise<EmailDetail> =>
    request<EmailDetail>(`/emails/${encodeURIComponent(id)}/resolve-match`, {
      method: 'POST',
      body: JSON.stringify({ entityType, entityId: entityId ?? 'create_new' }),
    }),
};
