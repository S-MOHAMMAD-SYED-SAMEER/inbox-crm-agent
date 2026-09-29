# Project 2 — Inbox-to-CRM Agent: Full System Audit

**Date:** 2026-08-25
**Scope:** M0 through M4-D, complete system
**Purpose:** determine whether the system is ready for Gmail and HubSpot integrations
**Method:** code tracing, not README claims. Every finding below cites the file and line it came from,
or is marked **NOT VERIFIED**.

**Baseline at audit time:** 531 server tests, 53 web tests, 7 schema-parity tests, 6 evaluations —
all passing. No credentials, no outbound mail sent, no deployment.

---

## 1. Executive summary

The system does what it claims. The central architectural promise — *the model proposes, deterministic
code disposes, a human authorises anything consequential, and the executor verifies independently* —
holds under tracing, not merely under test. I attempted to break it from the executor directly,
bypassing the UI entirely, and could not.

**It is not ready for Gmail or HubSpot**, for one reason that has nothing to do with the agent
architecture: **there is no authentication on any endpoint**. Every route is open, and the operator
identity used in the audit trail is a self-asserted HTTP header. That is defensible for a local demo
and indefensible the moment the system holds a real mailbox token or writes to a real CRM.

The second gap is that **PostgreSQL has never been executed**. The portability work is real and
carefully done, but "carefully written" and "verified" are different claims, and the README is honest
about this.

Nothing else found rises to CRITICAL. The security properties I could test — approval enforcement,
fingerprint binding, guardrail re-runs on human edits, superseded/expired refusal, outbound
disablement, secret containment, audit append-only, SQL parameterisation — all hold.

**Two findings surprised me and are worth reading in full:** F-05 (concurrent execution is protected
by accident, not by design) and F-08 (the email state machine exists only as scattered calls).

---

## 2. Architecture assessment

### The traced path

Every boundary below was read in source, not inferred.

| Stage | Input | Output | Authority | Failure behaviour |
|---|---|---|---|---|
| **Ingest** | `EmailSource.fetchNew` | `emails` row | Provider message id + UNIQUE | Duplicate → no-op, audited |
| **Sanitise** | Raw body | Body capped at 100 KB | Code | Truncation is audited, never silent |
| **Understand** | Fenced email in a *user* turn | `email_analyses` row | **Model, for evidence only** | Unusable output → one repair retry → `needs_review` |
| **Validate** | Model output | Dropped fields | Code (provenance) | Unsupported value → `not_provided` + audit |
| **Injection** | Body heuristics + model flag | `flags.possibleInjection` | Code | Forces approval; draft withheld |
| **Resolve** | Analysis + CRM | `entity_matches` rows | **Deterministic scoring, no model** | Conflict → `needs_review`, nothing written |
| **Decide** | Analysis + resolution + settings | `decisions` row | **Rules engine, no model** | Draft failure never fails the plan |
| **Approve** | Human | `approvals` row + `plan_hash` | **Human** | Terminal states are terminal |
| **Revise** | Human edits (whitelisted) | New `decisions` row | **Human, content only** | Any refusal writes nothing |
| **Execute** | Decision + approval | CRM rows in one transaction | **Executor re-verification** | Rollback; failure rows written after |
| **Outbound** | Approved draft | `outbox_messages` status | **Two server-side locks** | Failure never reads as sent |
| **Audit** | Every stage | `audit_events` | Append-only | UNIQUE(correlation, sequence) |

### Can a lower-trust layer override a higher one?

**No path found.** The three I specifically hunted for:

- Model output reaching `requiresApproval()` — the function has no field for it
  (`agent/policy/approval.ts:34-46`), and there must never be one.
- Request body reaching the send path — traced end to end; `createOutboundSender()` reads
  `process.env` only (`adapters/outbound/index.ts:44`).
- Email content becoming instruction — content arrives in a *user* turn inside an escaped fence
  (`agent/understand/prompt.ts:31`), never in the system prompt.

**Assessment: sound.** The layering is the strongest part of this system.

---

## 3. Trust-boundary assessment

| Concern | Authoritative layer | Verified at |
|---|---|---|
| Action type | Action registry (closed set) | `domain/actions.ts:55` |
| Risk tier | Registry, derived from action types | `planRiskTier` |
| Approval requirement | `requiresApproval()` + stored floor | `executor.ts:143` |
| Recipient | The approved plan's action payload | `executor.ts` delivery step |
| Draft safety | Six deterministic guardrails | `decide/draftGuardrails.ts` |
| CRM identity | Deterministic resolution | `agent/resolve/` |
| Execution | Executor's independent re-verification | `executor.ts:57-164` |
| Outbound capability | Server environment, two locks | `domain/outbound.ts:68` |
| Audit history | Database, append-only | No UPDATE/DELETE exists |

**What the model is trusted to do — exactly:**

1. Classify an email (category, priority, intent, summary).
2. Report a confidence number, which is treated as *evidence*, never as permission.
3. Extract field values, **each of which must quote text present in the email** or be dropped.
4. Raise flags that can only ever *increase* caution.
5. Write prose for a reply (subject and body), which then faces six deterministic checks.

**What it cannot do:** create an action, choose an action type, set a risk tier, set the approval
flag, name a recipient, approve anything, execute anything, or send anything. Verified by reading the
tool schemas: the UNDERSTAND tool exposes `category, confidence, extracted, flags, intent, priority,
summary` and the DRAFT tool exposes `subject, body`. There is no action field in either.

**Assessment: correctly drawn and correctly enforced.**

---

## 4. Security assessment

### Traced and found sound

- **SQL injection** — every interpolation into SQL is a code-controlled fragment (`${where}`,
  `${clauses}`, `${table}`) built from literals; all values are parameterised. `crm.ts:172-174`
  escapes `%`, `_` and `\` before a LIKE and uses `ESCAPE '\'`. No user string reaches SQL structure.
- **Secret exposure to the browser** — the web app reads no environment variable and holds no key;
  `grep` for `import.meta.env` / `process.env` in `web/src` returns nothing.
- **Log redaction** — `lib/redact.ts` drops `authorization`, `token`, `refreshtoken`, `accesstoken`,
  `secret`, `databaseurl`. No email body reaches any logger call.
- **Audit leakage** — outbound events carry recipient, provider and message id; never subject or
  body. Blocked-edit events carry guardrail *names* only.
- **Approval / fingerprint / revision / expiry / superseded bypass** — each attempted directly
  against the executor. All refused with named codes.
- **Guardrail bypass via human edit** — all six re-run on edited drafts; none can be weakened.
- **Arbitrary recipient** — the delivery step compares the outbox row against the plan's action and
  refuses `recipient_mismatch`.
- **Arbitrary action / provider invocation** — closed registries; no dynamic dispatch from input.

### Findings

**F-01 · CRITICAL · No authentication on any endpoint**
*Evidence:* 18 routes across `routes/emails.ts` and `routes/health.ts`; no auth middleware exists
(`grep` for session/JWT/bearer returns only a comment at `routes/emails.ts:101`). Operator identity
comes from a self-asserted `x-operator` header (`routes/emails.ts:103,127`).
*Impact:* anyone who can reach the port can approve plans, execute them, revise them, and — once
outbound is enabled — cause mail to be sent, while attributing it to any name they choose. The audit
trail records the claim, not the actor.
*Recommendation:* authentication before any real mailbox or CRM is connected. Session or token; the
identity must come from it, not from a header.
*Blocks Gmail:* **YES.** *Blocks HubSpot:* **YES.** *Blocks demo deployment:* **YES if publicly
reachable**; acceptable on localhost.

**F-02 · HIGH · No rate limiting, contrary to spec §11**
*Evidence:* spec §11 specifies `/emails/ingest` 60/min, `/emails/:id/process` 20/min, approvals
120/min. `RATE_LIMITED`/429 exist in `lib/errors.ts:22,34` but nothing enforces them.
*Impact:* combined with F-01, an unauthenticated caller can drive `/emails/decide` in a loop. That
endpoint makes model calls, so this is direct spend, not just load.
*Recommendation:* the in-memory token bucket the spec already specifies. No dependency needed.
*Blocks Gmail:* **YES** (Gmail adds real per-call cost and quota). *Blocks HubSpot:* **YES.**
*Blocks demo deployment:* **YES if publicly reachable.**

**F-03 · HIGH · No CSRF protection and no CORS policy**
*Evidence:* no CORS configuration in `app.ts`; no CSRF token anywhere. All state-changing routes are
plain `POST` with JSON bodies.
*Impact:* today this is low-severity because there are no cookies to ride — an attacker page cannot
authenticate. It becomes serious the moment F-01 is fixed with cookie-based sessions.
*Recommendation:* decide the auth mechanism first; if cookies, add CSRF protection in the same
change. Set an explicit CORS policy either way.
*Blocks Gmail:* **YES**, jointly with F-01. *Blocks HubSpot:* **YES.** *Blocks demo:* NO (localhost).

**F-04 · INFORMATIONAL · Prompt-injection defence is layered and holds**
*Evidence:* fenced user-turn delivery, fence-escaping, heuristic detector, model flag, forced
approval, draft withheld, audited. The E-06/D6 evaluation case measures containment at 1.0.
*Impact:* none — this is a positive finding, recorded because it is a claim worth being able to
defend on a client call.

---

## 5. Database assessment

8 migrations, 16 tables, 29 indexes on a fresh database — verified by running them. Checksums enforce
immutability (`db/migrate.ts:82`); one transaction per migration file.

- **Foreign keys:** present and enforced (`PRAGMA foreign_keys = ON`, verified by an insert that fails).
- **Unique constraints:** `emails(provider, provider_message_id)`, `approvals(decision_id)`,
  `action_executions(idempotency_key)`, `audit_events(correlation_id, sequence)` — all verified live.
- **CHECK constraints:** every enum is constrained and parity-tested against its TypeScript union
  (7 parity tests). The helper follows `ALTER TABLE … RENAME TO` so a rebuilt table is checked in its
  current form, not its fossil.
- **Soft delete:** `deleted_at` on all six CRM tables; every read filters it; no hard `DELETE`
  outside the seed reset.
- **Audit append-only:** the repository exposes `append`, `count`, `list`, `listByCorrelation`,
  `listByEmail` — no update, no delete. No `UPDATE`/`DELETE` against `audit_events` exists anywhere.
- **Migration 008** is the only non-additive one (a portable table rebuild for a CHECK change). It was
  verified both on a fresh database and as an in-place upgrade from 007 with data present — the row
  survived byte-for-byte and every constraint was re-established.

**No unsafe migration found.**

**F-05 · MEDIUM · Concurrent execution is protected by accident, not by design**
*Evidence:* I probed two concurrent `executePlan` calls on one approved decision after a failed
delivery. Result: **exactly one delivery** — but because the second call collided on
`audit_events(correlation_id, sequence)` while appending `outbound_send_attempted`, which happens
*before* `sender.send()`. The outbox row is not claimed before sending; `markSent` guards the
*record*, not the *send*.
*Impact:* the outcome is currently correct, and the ordering that makes it correct is not documented
or tested as a safety property. A future reordering — moving the audit append after the send, or
making audit sequencing lock-free — would silently introduce duplicate customer emails. The failure
also surfaces as an unhandled 500 rather than a clean conflict.
*Recommendation:* claim the outbox row before delivery with a conditional UPDATE, so the guarantee is
explicit. This needs a new `sending` status, i.e. a CHECK change, i.e. a migration — which is why I
have **not** implemented it here. Add a test asserting one delivery under concurrency.
*Blocks Gmail:* **YES** — duplicate mail to a customer is the worst failure this system can have, and
Gmail is where it becomes real. *Blocks HubSpot:* NO. *Blocks demo:* NO.

**F-06 · LOW · SQLite and Postgres differ in audit-sequence contention**
*Evidence:* `audit.ts:60` computes `MAX(sequence)+1` inside a transaction. SQLite serialises on one
connection; Postgres under READ COMMITTED permits two transactions to read the same maximum.
*Impact:* on Postgres the UNIQUE constraint still prevents a wrong sequence — it fails loudly, which
is the documented intent. Expect *more* of these errors under real concurrency than SQLite shows.
*Recommendation:* acceptable as-is; revisit if contention appears. Do not weaken the constraint.
*Blocks:* nothing.

---

## 6. PostgreSQL assessment

**F-07 · HIGH · Postgres has never been executed**
*Evidence:* `README.md:204` states it plainly. No Postgres server, no Docker, no Neon account. The
`pg` driver is implemented and typechecked; its wire behaviour is **NOT VERIFIED**.
*Impact:* schema, dialect translation, placeholder conversion, boolean marshalling and transaction
semantics are all reasoned-correct and untested against the real engine.
*Recommendation:* one throwaway Neon branch, `npm run migrate && npm run seed && npm test` against it.
This is a few hours, not a project.
*Blocks Gmail:* NO. *Blocks HubSpot:* NO. *Blocks demo:* NO (SQLite is the demo path).
*Blocks production:* **YES.**

### Transaction binding — audited exhaustively

Every `transaction(` call site was read:

| Site | Binding | Verdict |
|---|---|---|
| `executor.ts:264` | `repos.transaction` → tx-bound | Correct (fixed M4-C.2.1) |
| `revise.ts:266` | `repos.transaction` → tx-bound | Correct |
| `seed.ts:179` | `repos.transaction` → tx-bound | Correct (fixed M4-D) |
| `seed.ts:332` | `db.transaction`, uses `tx.execute` | Correct |
| `audit.ts:60` | `db.transaction`, uses `tx.query`/`tx.execute` | Correct |
| `decisions.ts:137` | `db.transaction`, uses `tx.*` | Correct |
| `entityMatches.ts:73` | `db.transaction`, uses `tx.*` | Correct |
| `migrate.ts:98` | `db.transaction`, uses `tx.*` | Correct |

**No root-bound repository escapes a transaction.** Both historical defects (executor, seed) are
fixed and each carries a regression test that fails against the old code — I verified that by
reverting and re-running.

**Boolean portability:** `sqlite.ts:19-26` converts booleans to 0/1 on write; `rows.ts` converts back
on read; Postgres takes them natively. Correct on both sides.

---

## 7. State-machine assessment

### Approvals — the one that matters, and it is sound

`pending → approved | rejected | expired | superseded`. All four destinations terminal, enforced in
one place: `decide()` moves only from `pending`, guarded in the WHERE clause so concurrent settlement
cannot double-resolve. **An expired, rejected or superseded approval can never become executable** —
tested from the executor directly for each.

### Outbox

`queued → sent | suppressed | failed`, `failed → sent` on retry. `sent` is terminal: `markSent` and
`markFailed` both carry `WHERE status <> 'sent'`.

### Decisions

Append-only. A revision or re-decide writes a new row and sets `superseded_by`; nothing is edited.

**F-08 · MEDIUM · The email state machine exists only as scattered calls**
*Evidence:* 13 states in `EMAIL_STATES`, set from 8 distinct `setState` call sites. The optional
`expectedFrom` compare-and-swap guard exists (`emails.ts:139`) but is used in **exactly one place**
(`expiry.ts:86`). There is no declared transition table and no test that enumerates legal transitions.
*Impact:* the security-relevant guard is elsewhere and does hold — `verifyExecutable` permits
execution only from `awaiting_approval | deciding | execution_failed`. But "which transitions are
legal?" is currently answerable only by reading eight call sites, and an incorrect transition added
later would not be caught by anything.
*Recommendation:* declare the transition table in `domain/email.ts` and have `setState` consult it.
Low effort, removes a whole class of future bug. Not urgent.
*Blocks:* nothing.

---

## 8. Idempotency assessment

Traced and tested per operation:

| Operation | Repeat behaviour | Mechanism | Proven by |
|---|---|---|---|
| Ingest | No-op | `UNIQUE(provider, provider_message_id)` | test |
| Understand | New analysis row (versioned) | By design — history is kept | test |
| Resolve | New resolution run | By design | test |
| Decide | New decision, old superseded | By design | test |
| Approve | Second attempt → CONFLICT | State guard in WHERE | test |
| Revise | Second attempt on v1 → refused | `decision_superseded` | test |
| CRM create/update | No duplicate | `UNIQUE(idempotency_key)` | test + eval |
| Tasks / activities / notes | No duplicate | same | eval |
| Outbound send | Exactly one delivery | Outbox status check | test + eval |

Three consecutive executions of an approved revised plan produce one set of CRM rows, one outbox row,
one delivery. `duplicateSideEffects = 0` and `duplicateOutboundSends = 0` are measured against real
attempt counts, not asserted.

The one caveat is F-05: single-threaded idempotency is proven; concurrent idempotency of the *send*
is currently incidental.

---

## 9. AI / LLM assessment

Covered in §3. Additional specifics:

- **Structured output is forced** — a required tool call, not free text.
- **Output shape is validated** before use; unusable output gets one repair retry, then `needs_review`.
- **Provenance is validated** — a field whose value does not appear in the email is dropped to
  `not_provided` and audited. `hallucinatedFieldRate = 0` on the eval set.
- **Confidence is evidence, not authority** — a band below `high` forces approval.
- **No model call is made in any test or evaluation.** All six evaluations run on the deterministic
  mock provider. Verified: zero Anthropic calls this session.
- **The Anthropic provider is implemented and unit-tested against a stub**, but has **never been run
  against the live API**. NOT VERIFIED: the wire contract.

---

## 10. Human-approval assessment

I attempted the bypass directly, calling `executePlan` with no UI involved:

- Unapproved tier-2 plan → `approval_not_granted`, nothing written, no provider call.
- Approval on a superseded plan → `decision_superseded`.
- Expired approval → refused; the sweep moves the email to `needs_review` and never executes.
- Plan altered after approval → `plan_changed_since_approval`.
- Autonomy loosened after the plan was made → the stored requirement acts as a floor; still refused.

**No autonomy level permits tier-2 auto-execution.** Asserted across all three levels by a dedicated
test. `send_email`, `create_deal`, `update_deal_stage` and `update_deal_amount` are tier 2 and always
require a human.

**Assessment: the core product claim is true and enforced at the layer that matters.**

---

## 11. Outbound assessment

Two locks, AND-ed, both server-side, neither reachable from a browser:
`ALLOW_OUTBOUND_SEND` (default `false`) and `OUTBOUND_PROVIDER` (default `none`).

Tested at all three configurations — disabled, partially enabled (either lock alone), fully enabled:

| Property | Result |
|---|---|
| Disabled → suppressed, no provider call | ✔ |
| Either lock alone → cannot send, and says so at boot | ✔ |
| Approval still required when enabled | ✔ |
| Fingerprint still required | ✔ |
| Guardrails still required | ✔ |
| Superseded refused | ✔ |
| Expired refused | ✔ |
| Duplicate send prevented | ✔ (single-threaded; see F-05) |
| Failed send never marked sent | ✔ all four failure modes |
| Provider exception never marked sent | ✔ |
| Revision sends v2 only | ✔ subject, body, recipient, decision id |

No real mail sent. No network call in any test — the mock provider is a local object.

---

## 12. Revision assessment

All eleven properties in the brief verified:

v1 immutable (byte-identical after revision) · v2 provenance correct · parent link correct · revision
number monotonic · fresh approval bound to v2 alone · fresh fingerprint · audit ordered
(`plan_revised` before `approval_granted`) · edits restricted to a whitelist · action type and action
set unmodifiable · risk tier cannot be lowered · guardrails re-run on edited drafts · no-op revisions
refused.

**One structural note worth recording:** an edit can never turn `requiresApproval` from false to true,
because a plan needing no approval has no approval record and is therefore not editable at all. The
floor only ever has to defend one direction — the safe one. This is a property of the admission rule,
locked by a test, not an oversight.

---

## 13. API assessment

18 endpoints. Every one: validated input via a hand-written collector that reports *all* problems;
`{error:{code,message,details}}` envelope; state validated server-side; audited where it mutates.

| Property | Status |
|---|---|
| Input validation | Present on every mutating endpoint |
| Authentication | **None** (F-01) |
| Authorization | **None** — no roles, no ownership |
| Rate limiting | **None** (F-02) |
| Body size cap | 256 KB, per spec |
| Error shape | Consistent; no stack traces, no SQL, no email bodies |
| Idempotency | Enforced at the data layer, not via idempotency headers |

**F-09 · MEDIUM · Validation errors return 400, while the M4-C brief specified 422**
*Evidence:* `lib/errors.ts:28` maps `VALIDATION_ERROR → 400`; spec §11 documents that envelope.
*Impact:* cosmetic and consistent. Flagged in M4-C.2 and left deliberately rather than making one
endpoint disagree with the other seventeen.
*Recommendation:* Sameer's call. One line changes all of them together.
*Blocks:* nothing.

---

## 14. Frontend assessment

Screens: Inbox, Email detail, Approvals (with revision UI), execution panel, audit view, plus loading,
empty and error states throughout.

**The frontend never claims more than the server said.** Specifically checked:

- "approved" is shown only for `approval.state === 'approved'`.
- "executed" comes from execution records, not from a request having been made.
- **"Sent" appears only for `outbox.status === 'sent'`** — the one status that means a customer has the
  message. `suppressed`, `failed` and `queued` each have their own wording, and a test asserts none of
  them contains the word "sent". A queued message reads "Waiting in the outbox" precisely because
  "waiting to be sent" is one careless glance away from reading as "sent".
- A revision reports "Revision N created and submitted for approval", and a test forbids the words
  *approved*, *executed*, *sent* and *done* in that message.

Actionability is computed from server state, never from styling. Approve/reject controls do not exist
for a settled approval. All five approval states carry a unique non-colour marker.

**Frontend logic is tested as plain modules** (`node --test`, no jsdom, per NFR-9) — 53 tests. The
components are thin renderers over `src/revision/`.

---

## 15. Evaluation assessment

Six evaluations, all offline and free. **Ran each twice and diffed the metric block: all six are
byte-identical across runs.**

| Evaluation | Measures | Vacuity guard |
|---|---|---|
| UNDERSTAND | Classification, extraction F1, provenance, injection containment | Fixed 10-case dataset |
| RESOLUTION | Verdict accuracy, conflict detection, zero CRM writes | 8 cases, conflict case required |
| DECIDE | Action accuracy, policy accuracy, unsafe-action rate, determinism | 7 cases |
| EXECUTE | Approval bypass, duplicates, blocked sends, expiry, queue order | `expiredSwept > 0` required |
| REVISION | 11 revision properties | Every rate paired with attempts; `< 6` unsafe attempts fails |
| OUTBOUND | 11 delivery properties | Every zero-tolerance metric paired with attempts |

**Vacuity is explicitly guarded, and the guard has history.** M4-B shipped an expiry check that ran in
a world where nothing could expire, reported a perfect score, and proved nothing. Since then every
evaluation fails when an attempt count is zero.

**Negative controls were run, not assumed.** For REVISION I disabled the guardrail re-run and removed
the executor's stored-flag floor — the evaluation failed with three named threshold breaches. For
OUTBOUND I removed the approval requirement and the disabled-sender check — it failed with four. All
changes were restored from backup and re-verified.

**No threshold has ever been lowered to obtain a green result.**

---

## 16. Test assessment

531 server + 53 web = **584 tests**, categorised by reading them:

| Category | Approx. count | Where |
|---|---|---|
| Unit (pure logic) | ~120 | `lib`, `policy.approval`, dialect, normalise |
| Database / repository | ~75 | `db.repositories`, `db.migrate`, `db.dialect` |
| Contract / parity | ~20 | `domain.schema-parity`, config contracts |
| Pipeline integration | ~150 | `m1`–`m3` pipeline and stage suites |
| Security / bypass | ~90 | `m4a`, `m4c2`, `m4d`, injection, provenance |
| Lifecycle end-to-end | ~30 | `m4c4`, `m4b`, `executor.transaction` |
| Regression (named defects) | ~10 | executor + seed transaction binding |
| API / HTTP | ~10 | `app.test`, HTTP revision test |
| Frontend logic | 53 | `web/test` |

**Quality is high by the measure that matters:** the regression tests were each verified to *fail*
against the pre-fix code. Tests that would pass either way prove nothing, and two in this codebase
were rewritten during earlier milestones for exactly that reason.

**F-10 · MEDIUM · Untested production risks**
*Evidence:* no test covers (a) concurrent requests against the same email — F-05's protection is
incidental and unasserted; (b) the Postgres driver against a live server; (c) sustained load or
pagination beyond demo volume.
*Impact:* three areas where behaviour is reasoned rather than observed.
*Recommendation:* (a) after F-05's fix; (b) with F-07; (c) not needed at current scale.
*Blocks Gmail:* (a) yes, jointly with F-05. *Blocks HubSpot:* NO. *Blocks demo:* NO.

---

## 17. Performance assessment

Not prematurely optimised, correctly. Two real inefficiencies found by tracing:

**F-11 · MEDIUM · The approval queue fetches up to 2,500 rows to compute five counts**
*Evidence:* `handlers/emails.ts:752-754` loops `APPROVAL_STATES` calling
`listByState(value, 500).length` — a `SELECT *` of up to 500 full rows per state, five times, to
produce five integers.
*Impact:* invisible at demo scale (7 approvals). At a few thousand approvals it is the slowest thing
in the app and the counts silently cap at 500 — the number displayed becomes *wrong*, not just slow.
*Recommendation:* `SELECT state, COUNT(*) FROM approvals GROUP BY state`. One query, always correct.
*Blocks:* nothing. Worth doing before any real inbox.

**F-12 · LOW · N+1 queries in two read paths**
*Evidence:* the approval queue issues 3 queries per row (decision, email, analysis);
`handleGetEmail` issues one approval query per revision.
*Impact:* ~25 queries for a 7-row queue. Fine now, linear in volume later.
*Recommendation:* batch when it matters. Not now.

**Limits — current and recommended:**

| Thing | Current | Recommended |
|---|---|---|
| Email body | 100 KB, truncated + audited | Keep |
| Draft subject / body | 200 / 4,000 chars | Keep |
| API request body | 256 KB | Keep |
| Inbox page | 50, capped 500 | Keep |
| Audit list | 100, capped 500 | Keep |
| Audit payload | **unbounded** | Cap at ~8 KB and truncate with a marker |
| Approval queue | 200 | Keep, but fix F-11 |

**F-13 · LOW · Audit payloads have no size cap**
*Evidence:* `audit.append` serialises `payload` with no limit. Current callers pass small objects
(ids, codes, path lists), so nothing is large today.
*Impact:* a future caller passing a large structure would bloat the table silently.
*Recommendation:* cap and truncate with an explicit marker.

**No Redis, queue, worker or cache is needed.** Nothing found justifies one.

---

## 18. Integration readiness

### Gmail — **NOT READY**

The adapter seam is genuinely in place: `EmailSource` with an optional `send`, and `OutboundSender`
as a separate boundary. A Gmail adapter is a new file implementing one or both; no caller changes.
The `gmail` provider name is already declared and falls back to disabled with a startup warning.

Unresolved, and each needs a decision before code:

| Concern | Status |
|---|---|
| Authentication boundary | **Blocked by F-01.** OAuth tokens cannot live behind an unauthenticated API |
| Token storage / refresh | Not designed. No encrypted-secret story exists |
| Read scope | `gmail.readonly` sufficient for ingest |
| Send scope | `gmail.send` — separate consent, should be separately gated |
| Message identity | `providerMessageId` already threaded through; maps to Gmail message id |
| Threading | `threadId` column exists and is populated; `inReplyToProviderMessageId` plumbed to the sender |
| Retries | Executor retry exists; no backoff policy for provider 429/5xx |
| Rate limits | **F-02 must be fixed first** |
| Polling vs webhook | Not decided. Polling fits the current explicit-trigger design; Pub/Sub push needs an authenticated endpoint |

**Blockers: F-01, F-02, F-05.** Plus a token-storage design.

### HubSpot — **NOT READY, but closer**

`CrmAdapter` exists as a boundary with a local implementation, and the action registry is closed and
already maps cleanly.

| Concern | Status |
|---|---|
| Entity mapping | Companies/contacts/deals/tasks/activities/notes all have HubSpot analogues |
| Contact identity | Email-based resolution already deterministic; HubSpot dedupes on email too |
| Company identity | Domain-based; matches HubSpot's model |
| Deal identity | Local ids; needs a HubSpot-id mapping column |
| Atomicity | **The real problem.** The executor guarantees all-or-none via a database transaction. HubSpot has no transaction |
| Partial failure | `adapterSupportsAtomicity: false` already forces approval for multi-action plans — the policy anticipated this |
| Rate limits | Not designed |

**F-14 · HIGH · A remote CRM cannot honour the atomicity guarantee**
*Evidence:* `executor.ts` applies a plan in one database transaction. FR-28 promises "all actions or
none". A HubSpot adapter cannot roll back a created company after a failed deal.
*Impact:* the guarantee silently weakens from "atomic" to "best-effort with compensation" the moment
a remote CRM is introduced.
*Recommendation:* decide explicitly — either compensating actions per action type, or accept partial
application and make the UI say so. The policy hook already exists; the semantics do not.
*Blocks Gmail:* NO. *Blocks HubSpot:* **YES.** *Blocks demo:* NO.

---

## 19. Cost assessment

| Category | Today | Notes |
|---|---|---|
| **Demo** | **₹0** | Mock provider, SQLite, local. No key needed |
| **Local dev** | **₹0** | Same |
| **Tests + all 6 evaluations** | **₹0** | Zero model calls; verified |
| Claude API (optional) | ~₹1,000 starter | Haiku 4.5 for chat/draft; Sonnet 5 only in Project 3 |
| Postgres hosting | ₹0 (Neon free) → ~₹500/mo | Needed for F-07 verification |
| Deployment | ₹0 (Vercel/Render free) → ~₹500/mo | Not yet done |
| Gmail / Google Cloud | ₹0 at low volume | Free quota is generous |
| HubSpot | ₹0 (free CRM tier) | Paid tiers only at scale |

**Nothing paid has been activated.** ₹0 spent on this project to date beyond Claude Pro.

---

## 20. Open decisions

| Item | Class | Reasoning |
|---|---|---|
| Field-level edit markers (✎) | **DEFER** | Spec §13.5 shows them; needs `edit_diff` exposed on the API. Cosmetic; plan-level attribution already works |
| `create_deal.stage` editability | **KEEP** immutable | Pipeline position is reported business state. Revisit with real usage |
| `manual` vs `assisted` default | **CHANGE** | §16 says `manual`; §22's demo needs `assisted` for tier-0 auto-execution. Open since M4-B. **This is the one that affects what a client sees on first run** — recommend `assisted` for demo, `manual` for a new client |
| `OUTBOUND_MOCK_BEHAVIOUR` env var | **KEEP** | Lets failure handling be demonstrated live without a provider. Cannot enable sending by itself |
| "Sent via demo provider" wording | **KEEP** | Only shown on server-confirmed `sent`. Accurate |
| Postgres readiness | **BLOCKER** for production | F-07 |
| Authentication / multi-tenancy | **BLOCKER** | F-01. The single largest gap |
| Rate limiting | **BLOCKER** | F-02, and the spec already specifies it |
| Gmail | **DEFER** until F-01, F-02, F-05 | |
| HubSpot | **DEFER** until F-01, F-14 | |
| Deployment | **DEFER** until F-01, F-02 | Safe on localhost today |
| Validation 400 vs 422 | **DEFER** | F-09, cosmetic |

---

## 21. Findings by severity

| ID | Severity | Finding | Gmail | HubSpot | Demo |
|---|---|---|---|---|---|
| F-01 | **CRITICAL** | No authentication on any endpoint | ✖ | ✖ | ✖ if public |
| F-02 | **HIGH** | No rate limiting (spec §11 requires it) | ✖ | ✖ | ✖ if public |
| F-03 | **HIGH** | No CSRF protection, no CORS policy | ✖ | ✖ | — |
| F-07 | **HIGH** | Postgres never executed | — | — | — |
| F-14 | **HIGH** | Remote CRM cannot honour atomicity | — | ✖ | — |
| F-05 | **MEDIUM** | Concurrent send protected by accident | ✖ | — | — |
| F-08 | **MEDIUM** | Email state machine undeclared | — | — | — |
| F-09 | **MEDIUM** | Validation returns 400, brief said 422 | — | — | — |
| F-10 | **MEDIUM** | Concurrency/Postgres/load untested | ✖ | — | — |
| F-11 | **MEDIUM** | Queue counts fetch 2,500 rows; wrong past 500 | — | — | — |
| F-06 | **LOW** | Audit-sequence contention differs on Postgres | — | — | — |
| F-12 | **LOW** | N+1 in two read paths | — | — | — |
| F-13 | **LOW** | Audit payloads uncapped | — | — | — |
| F-04 | **INFO** | Injection defence layered and holding | — | — | — |

**No CRITICAL finding exists in the agent architecture itself.** The one CRITICAL is a missing
application-layer concern that was never in scope for M0–M4-D.

---

## 22. Recommended fixes, in order

1. **F-01 authentication** — the gate everything else waits behind.
2. **F-02 rate limiting** — the spec already specifies the design; no dependency.
3. **F-11 queue counts** — one query; also fixes a wrong number past 500 approvals.
4. **F-05 outbox claim** — needs a migration for a `sending` status. Before Gmail, not before demo.
5. **F-07 Postgres verification** — one throwaway Neon branch.
6. **F-14 HubSpot atomicity decision** — a design decision, not code.
7. **F-08 state transition table** — cheap, prevents a class of future bug.
8. **F-13 audit payload cap** — cheap.
9. **F-03 CORS/CSRF** — decide alongside F-01.
10. **F-09, F-12** — cosmetic and premature respectively.

---

## 23. Recommended roadmap

**Before any external integration:** F-01, F-02, then F-05 and F-07.
**Before Gmail:** the above, plus a token-storage design and a decision on polling vs push.
**Before HubSpot:** F-01 plus the F-14 atomicity decision.
**Before a public demo:** F-01 and F-02, or keep it on localhost / behind a tunnel with basic auth.
**Not now:** queues, workers, caching, multi-tenancy, background schedulers. Nothing found justifies
any of them.

---

## 24. Production-readiness score

**6 / 10 — the domain is production-grade; the application shell is not.**

| Dimension | Score | Note |
|---|---|---|
| Agent architecture | 9 | Layering is genuinely sound |
| Safety / human-in-the-loop | 9 | Verified by attempted bypass, not assumption |
| Data model | 8 | Constraints real, parity enforced, append-only holds |
| Testing | 8 | 584 tests; regressions verified to fail pre-fix |
| Evaluation | 9 | Deterministic, negative-controlled, vacuity-guarded |
| Error handling | 8 | Named, safe, audited, no leakage |
| **Authentication** | **0** | Does not exist |
| **Rate limiting** | **0** | Does not exist |
| Postgres readiness | 4 | Written carefully, never run |
| Observability | 6 | Excellent audit trail; no metrics or tracing |

---

## 25. Portfolio-readiness score

**9 / 10.** All thirteen capabilities in the brief are demonstrable today, on a laptop, for ₹0, with
no API key.

The one deduction: the demo runs on `manual` autonomy, so nothing auto-executes and every path needs
a click. That is the correct *product* default and the wrong *demo* default — see §20.

### The strongest demo flow

**The hero lead, end to end — about four minutes:**

1. Ingest ten emails; open the Acme Commerce enquiry.
2. Show the reading: category, confidence band, and **every extracted field quoting the sentence it
   came from**. That is the provenance story, and it lands.
3. Show the CRM match, with its score and evidence in plain language.
4. Show the plan: six actions, tier 2, and the specific sentence saying *why a human is needed*.
5. **Edit the drafted reply.** Show the change summary — before and after.
6. Show the history: revision 1 AI-generated and replaced, revision 2 human-edited and waiting.
7. Approve. Show five CRM records created atomically, and the reply sitting in the outbox marked
   **suppressed — nothing was sent**.
8. Open the audit trail and read the whole story back.

Then, if you want the moment that sells it: open E-06, the prompt-injection email, and show the
system refusing to follow the instruction embedded in the customer's message, flagging it, and
routing it to a human. Follow it with an attempt to put a price into the reply by hand and watch the
guardrail stop a *person*, not just the model.

---

## 26. Definition of ready for Gmail

- [ ] F-01 authentication, with identity from the session rather than a header
- [ ] F-02 rate limiting, per spec §11
- [ ] F-05 explicit outbox claim before delivery, with a concurrency test
- [ ] Encrypted token storage with a refresh path
- [ ] Read and send scopes separately gated; send stays behind both existing locks
- [ ] Backoff for 429/5xx, bounded and audited
- [ ] Polling-vs-push decided and documented
- [ ] `ALLOW_OUTBOUND_SEND` remains default-false after the integration lands
- [ ] One end-to-end test against a Gmail sandbox before any real address

## 27. Definition of ready for HubSpot

- [ ] F-01 authentication
- [ ] F-14 atomicity semantics decided and documented — compensation or acknowledged partial application
- [ ] Id-mapping columns for remote entity ids
- [ ] Rate-limit and backoff policy
- [ ] `adapterSupportsAtomicity: false` wired to the real adapter so multi-action plans force approval
- [ ] Partial-failure UI that states plainly what was and was not applied
- [ ] A conflict policy for records changed in HubSpot since resolution ran

---

*Audit performed by tracing source. Every claim above is either cited to a file, verified by
execution, or explicitly marked NOT VERIFIED. No finding was manufactured, and no passing test was
taken as evidence of a property it does not actually test.*
