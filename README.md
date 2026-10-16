# Inbox-to-CRM Agent (Project 2)

Turns inbound business email into tracked CRM records with drafted replies — while a human approves
anything consequential.

**Status: the M0–M7 milestones are complete, including approve-with-edits (M4-C) and a mock outbound
adapter (M4-D); it has session-based operator authentication and a public read-only demo mode that
is off by default.** The full chain runs: ingest → understand →
resolve → decide → approve → execute. An approved plan is applied to the CRM atomically and
idempotently, with before/after snapshots on every action. Work waiting on a person now has a real
queue — sorted by how little time is left on it, with a before/after diff of what approving would
change — and an approval that outlives its window is swept to human review rather than staying
silently executable. **Nothing is ever sent**: an approved reply stops at the outbox as `suppressed`.
The remaining known gap is a real outbound email provider: only a deterministic mock sender is
implemented, and `ALLOW_OUTBOUND_SEND`/`OUTBOUND_PROVIDER` refuse to deliver anything until one
exists.

Full specification: [`docs/PROJECT2_INBOX_CRM_SPEC.md`](./docs/PROJECT2_INBOX_CRM_SPEC.md).

## Run it locally

**Prerequisites:** Node.js 24 or newer (the `engines` field in `package.json`). Nothing else — no
database server, Docker, API key or account.

```bash
npm run demo
```

Run that from the repository root. It installs the dependencies, builds the dashboard, resets a local
SQLite database to the seeded demo CRM, and starts the app. When it prints `Open http://localhost:3100`,
open that address and sign in with the password printed in the terminal (made fresh for each run,
local only). Then use **Inbox → Ingest → Understand → Resolve → Decide**.

One terminal is enough: the server serves the dashboard on the same address as the API. It runs on
synthetic data with the deterministic mock LLM provider, so **no API key is needed**, and nothing is
ever sent. Every run starts from the same pristine state.

**The demo starts at `manual` autonomy**: every plan waits for you to approve it, so it never does
anything you did not click. `AUTONOMY_LEVEL=assisted npm run demo` starts it at `assisted`, where the
harmless tier-0 plans (archiving the spam, logging a support request) run on their own while anything
consequential still stops and asks. No autonomy level lets a consequential action run unattended.

**To run it on the real model** (Gemini, `gemini-3.5-flash-lite`), put `GEMINI_API_KEY` in `server/.env` and run
`cd server && npm run live`. It is the same one command with the real provider; it refuses to start without the
key and prints the provider, model and temperature (never the key). **It has not been run yet**: the Gemini
adapter is tested only against a fake client, and the first real request is a planned step. Each email costs
one to two requests, so click through the batches rather than scripting them. The Anthropic provider is
implemented and also unrun.

**Hosting your own copy** is optional and covered in [docs/HOSTING.md](./docs/HOSTING.md). Nothing is hosted for you.

<!-- DEMO_VIDEO: 60–90s screen recording of the app running locally goes here -->

## Development setup

The two-process setup below is for working on the code. The API refuses requests without a session, so
either use `npm run demo` above, or set `OPERATOR_PASSWORD_HASH` (from `npm run hash-password`) and
`COOKIE_SECURE=false` in `server/.env`. Nothing here needs an API key, a database server, Docker, or
an account.

```bash
# API
cd inbox-crm-agent/server
npm install
npm run migrate     # creates the schema (local SQLite by default)
npm run seed        # loads the demo CRM: 6 companies, 9 contacts, 4 deals, 5 tasks, 20 activities
npm run dev         # http://localhost:3100/api/health

# then, from the dashboard or with curl:
#   POST /api/emails/ingest      pulls the ten demo emails in
#   POST /api/emails/understand  reads every one of them
#   POST /api/emails/resolve      matches them against the CRM
#   POST /api/emails/decide       turns each into a plan and a draft
#   POST /api/decisions/:id/approve   approves and runs it
#   POST /api/decisions/:id/reject    rejects it, with a reason
#   GET  /api/approvals?state=pending the queue, soonest deadline first
#   POST /api/approvals/expire        sweeps anything past its window to human review

# Dashboard, in a second terminal
cd inbox-crm-agent/web
npm install
npm run dev         # http://localhost:5175
```

`npm run reset` clears everything and re-seeds, restoring the demo to an identical starting state —
ids included. It refuses to run against a database it does not recognise as demo data.

Port 3100, not 3000, so this runs alongside Project 1 during a demo.

## Verify it

```bash
cd server && npm test && npm run typecheck && npm run lint
cd server && npm run eval:understand && npm run eval:resolve && npm run eval:decide
cd server && npm run eval:execute && npm run eval:revise && npm run eval:outbound
cd web    && npm test && npm run typecheck && npm run lint && npm run build
cd server && npm run verify:browser    # signs in to the real app in headless Chrome (needs Chrome installed)
```

The same checks, plus `npm audit --audit-level=high`, run in CI on every push and pull request. The six
evaluations use the mock provider, so they say nothing about a real model; see **Evaluation** below.

## The architecture rule

> **The model proposes. Deterministic code disposes. A human authorises anything consequential.**

The model is used for the three things it is genuinely better at than code — classification,
extraction, and drafting — and for none of the things it is worse at: authority, arithmetic, state
transitions, and judging whether an action is safe.

This is the same decision Project 1 made when guardrails became application code rather than prompt
text, and for the same reason: a hostile or confusing email can influence what the model *says*, but
it can never influence what the code *allows*.

Three parts of that rule are already implemented and tested in M0:

| Guarantee | Where | How it is enforced |
|---|---|---|
| The agent cannot express a destructive action | [`src/domain/actions.ts`](server/src/domain/actions.ts) | The action registry is closed and contains no delete or bulk-update action. Not gated — absent. |
| A consequential action always needs a human | [`src/agent/policy/approval.ts`](server/src/agent/policy/approval.ts) | `requiresApproval()` is pure, deterministic, and never reads the model's opinion. No autonomy level, setting, or environment variable permits a tier-2 action to run unattended. |
| The audit trail cannot be rewritten | [`src/db/repositories/audit.ts`](server/src/db/repositories/audit.ts) | The repository exposes `append()` and reads. There is no update or delete method to call. |
| An email cannot instruct the agent | [`src/agent/understand/prompt.ts`](server/src/agent/understand/prompt.ts) | Content never enters the system prompt; it arrives fenced in a user turn, and the fence is escaped so content cannot close it. The only tool the model has describes an email — there is no tool that acts. |
| Matching is decided by code, never by a model | [`src/agent/resolve/`](server/src/agent/resolve/) | Entity resolution makes no model call at all. The analysis supplies evidence (a domain, a company name); fixed scores and thresholds decide what it is worth. |
| A close call is never silently promoted to a match | [`src/agent/resolve/resolve.ts`](server/src/agent/resolve/resolve.ts) | Two candidates within 0.10 are a conflict — checked *before* the auto-link threshold — and a lone mid-band candidate is not promoted for lack of competition. |
| The UI is not the security boundary | [`src/agent/execute/executor.ts`](server/src/agent/execute/executor.ts) | Before anything is written the executor re-runs the approval policy from stored facts, checks the approval record, its state, its expiry and a fingerprint of the plan that was approved. A caller cannot assert approval; there is no field for it. |
| An approved reply is never sent | [`src/agent/execute/executor.ts`](server/src/agent/execute/executor.ts) | The reply is written to the outbox as `suppressed`. No code path in this build delivers a message, and a guardrail-blocked draft is refused before the plan runs at all. |
| The model never chooses an action | [`src/agent/decide/rules.ts`](server/src/agent/decide/rules.ts) | Every action comes from a deterministic rule over the understanding and the resolution. The model is called *after* the plan is final, and its only tool records two strings of prose. |
| A draft cannot invent a price, a promise or a statistic | [`src/agent/decide/draftGuardrails.ts`](server/src/agent/decide/draftGuardrails.ts) | Six deterministic post-checks. The prompt asks; these check. A blocked draft is kept visible and forces approval rather than vanishing. |
| A value with no evidence never reaches the database | [`src/agent/understand/validate.ts`](server/src/agent/understand/validate.ts) | Every non-null field must quote text that appears in the email. Unsupported values are dropped to `not_provided`, and the drop is audited. |

## What is built

```
server/
  migrations/          10 SQL files — the schema from spec §10, plus the columns added since
  src/domain/          closed vocabularies: states, categories, actions, risk tiers, audit events
  src/db/              two drivers behind one interface, repositories, migration runner, seeding
  src/adapters/        llm (mock + anthropic) · email (demo source) · crm (local reader)
  src/agent/ingest/    sanitisation and ingestion
  src/agent/understand/  prompt, tool schema, validator, injection detector, orchestration
  src/agent/resolve/   normalisation, candidate generation, scoring, verdicts
  src/agent/decide/    business rules, draft prompt, draft guardrails, orchestration
  src/agent/execute/   the verification boundary and plan application
  src/agent/policy/    the approval gate
  src/eval/understand/ M1 evaluation: dataset loader, pure metrics, runner
  src/eval/resolve/    M2 evaluation: dataset loader, scoring and runner in one module
  src/eval/decide/     M3 evaluation: same shape as M2
  src/agent/approve/   the expiry sweep
  src/eval/execute/    M4-A/B evaluation: approval bypass, duplicates, blocked sends, expiry
  src/handlers/        pure {status, body} handlers
  src/lib/             errors, validation, redaction, logging, ids, clock
  data/demo/           E-01..E-10, each with a canned model response
  test/                746 tests
web/
  src/router.ts        ~60-line hash router (D4), unit-tested
  src/components/planDiff.tsx  the read-only before/after view of a plan
  src/screens/         Overview · Inbox · email detail · Approvals + placeholders for the rest
  test/                149 tests
```

895 tests total (746 server + 149 web), all currently passing.

## The UNDERSTAND pipeline

```
sanitised email
  → prompt          content fenced in a user turn, never in the system prompt
  → one model call  forced tool call; the only tool describes, it cannot act
  → shape           is this the right kind of object at all?          (fatal → one repair retry)
  → provenance      does every value quote text that is in the email?  (per-field → dropped)
  → coherence       does the answer contradict itself?                 (corrected, recorded)
  → confidence      high / medium / low band
  → injection       deterministic detector, authoritative over the model
  → persist         model output, effective understanding, validation and security kept apart
  → state           resolving | needs_review (+reason) | understand_failed
```

Uncertainty never resolves into action. Low confidence, ambiguity, missing information and suspected
injection each route the email to a person with a machine-readable reason.

## Entity resolution

```
understanding + the seeded CRM
  → candidates     everyone plausibly related, by address, domain and name token
  → scores         spec §7's table: exact email 1.00 · exact domain 1.00 · name 0.85/0.80
                   · fuzzy 0.70/0.65 · name-only 0.40 · thread +0.20
  → verdict        >= 0.80 MATCH · < 0.50 NO_MATCH · anything between, or two
                   candidates within 0.10, MATCH_CONFLICT
  → persist        every candidate with its score, method, evidence and the run verdict
  → state          deciding | needs_review (match_conflict)
```

No model call happens here, so the same email always produces the same candidates and the same
scores — which is what makes "how did it know that was the same company?" answerable with a number
and a quoted reason rather than "the AI decided".

**Resolution reads the CRM and never writes to it.** A NO_MATCH is a *proposal* to create a record,
which M3 turns into an action and M4 executes behind the approval gate. The evaluation asserts this
by counting CRM rows before and after a full run.

## DECIDE

```
understanding + resolution + CRM + settings
  → rules        18 deterministic rules; every one records why it did or did not fire
  → plan         ordered actions from the closed registry, with a risk tier
  → policy       requiresApproval() — the M0 function, unchanged
  → draft        the model writes prose, only where a reply is warranted
  → guardrails   six deterministic checks; a blocked draft forces approval
  → persist      plan, policy result, draft and their sources, in separate columns
  → state        awaiting_approval | deciding | needs_review
```

**The model is called after the plan is final.** It is handed a finished decision and asked to write
the covering text; its only tool records a subject and a body. There is no code path by which its
output can add an action, change a risk tier, or clear an approval requirement — and a test asserts
exactly that by feeding it a response that tries.

**A plan needing no approval rests in `deciding`, not `executing`.** M3 does not execute, so moving
the email there would have it claim something is happening when nothing is. M4 makes that transition
when it can honour it.

**Autonomy note.** The default is `manual` (§16: "the default for a new client"), under which every plan needs
approval, and the demo is seeded at `manual` too. Spec §22's tier-0 auto-execution for E-05 and E-09 is what
`assisted` means, so the DECIDE evaluation runs at `assisted`, and the demo walkthrough runs at both
(`npm run demo:walkthrough` at `manual`: 151 checks; `AUTONOMY_LEVEL=assisted npm run demo:walkthrough`: 153).

## Approval and execution

```
plan (M3)
  → approval      a pending row, bound to the decision, with an SLA
  → human         approve (records who, when, and a fingerprint of the plan) or reject with a reason
  → EXECUTOR      re-derives every safety fact from the database and refuses if any disagrees
  → apply         one transaction, idempotency key per action, before/after snapshots
  → outbox        an approved reply is stored as `suppressed` — never sent
  → state         completed | archived | execution_failed
```

**The executor is the boundary, not the UI.** It re-runs `requiresApproval()` from the stored
analysis, resolution and settings rather than reading the plan's cached flag; then it checks that an
approval exists, belongs to this decision, is `approved`, has not expired, and that a fingerprint of
the plan still matches what was approved. Eleven named refusal codes say exactly which check said no.

**Nothing can be sent.** A guardrail-blocked draft is refused before the plan runs. An approved reply
is written to the outbox with status `suppressed` and reason `outbound_send_disabled`. No code path
in this build delivers a message — `ALLOW_OUTBOUND_SEND` is not consulted as a permission, because
there is nothing for it to permit yet.

## Decisions worth being able to explain

### Why two database drivers when D1 chose PostgreSQL

PostgreSQL is the target, and the migrations are written as PostgreSQL DDL. But a first run should need
no database server, no Docker and no account, so `npm run migrate && npm run seed` works and the tests pass
**with zero credentials**.

So there are two drivers behind one `Database` interface: Node's built-in `node:sqlite` (the same
zero-dependency choice Project 1 made for its conversation memory) for local development and tests,
and `pg` for Postgres. Driver selection is *derived*, not configured: a `postgres://` URL
means Postgres, its absence means the local file.

The spec's portability rules (§9) were written to allow exactly this — app-generated UUIDs, `TEXT` +
`CHECK` instead of Postgres `ENUM`, no triggers or stored procedures — and honouring them is what
keeps D1 reversible rather than theoretical.

**Failure mode:** the two engines do not return identical JavaScript for identical columns (`BIGINT`
and `NUMERIC` arrive as strings from `pg`, booleans as `0`/`1` from SQLite). Handled in one place —
[`src/db/rows.ts`](server/src/db/rows.ts) — rather than in thirty repository methods.

**Postgres status, stated precisely.** The Postgres driver was run against a real PostgreSQL 16 server
(a throwaway container) on 2026-10-16: all 10 migrations apply, and `npm run verify:postgres` passes
**55 of 55** checks (constraints, transactions and savepoints, approvals and revisions, the outbox claim,
sessions, and real parallel connections racing for one claim). **The 754-test unit suite itself still runs
only on SQLite**: it builds a private in-memory database per test, which is not practical to repeat over a
network. So the driver is verified by that targeted script, not by the whole suite. To repeat it:

```bash
docker run -d --name icrm-pg -p 5433:5432 -e POSTGRES_USER=u -e POSTGRES_PASSWORD=p -e POSTGRES_DB=icrm postgres:16-alpine
cd server
export DATABASE_URL="postgres://u:p@localhost:5433/icrm?sslmode=disable"   # sslmode=disable: the driver demands TLS unless told otherwise
npm run migrate && npm run seed && npm run verify:postgres                 # seed first: the script's first two checks expect the demo data
```

### Why the migrations are translated rather than duplicated

One DDL source, translated at migration time for SQLite by a closed list of type-token substitutions
([`src/db/dialect.ts`](server/src/db/dialect.ts)). It is not a SQL translator and must never become
one: it handles declared type tokens and one default expression, all of which appear only in DDL in
this repository.

**Failure mode:** a rewrite that is subtly wrong produces a schema that looks fine and behaves
differently. That is why it is tested harder than its size suggests, including on the cases where it
must *not* act — `expected_close_date DATE` must translate the type and leave the column name alone.

### Why the approval gate never asks the model

`requiresApproval()` has no `modelSaysItIsSafe` input and must never gain one. Asking a model whether
its own action is risky produces an unverifiable claim about precisely the thing the system exists to
control — and an email crafted to manipulate the model would then be manipulating the safety check
itself. The model produces *evidence* (a category, a confidence, some flags); what happens next is
decided in code.

There is also a runtime invariant at the end of that function: if a tier-2 plan is ever not marked as
requiring approval, it throws rather than proceeding. Failing loudly is the correct behaviour for a
bug in the safety check itself.

### Why the model proposes and code disposes, concretely

Two cases in the demo dataset exist to make this visible rather than claimed:

**E-02** — the model reports a budget of `$5,000`. The email says only "we have a reasonable budget
in mind". The span it cites is real but contains no number, so the value is discarded, the field
shows *Not provided*, and the drop is written to the audit log along with the value that was claimed.
The model's original answer is kept in `model_output`, so the difference is a diff rather than an
opinion.

**E-10** — a prompt injection. The canned response is deliberately *fooled*: the model reads a clean
sales inquiry and does not raise its injection flag. The deterministic detector fires anyway, the
email is forced to `needs_review`, and nothing is written. The safety property does not depend on the
model noticing — which is the only kind of safety property worth having here.

### Why the injection detector is a signal, not the defence

The defence is structural: content is data and never instruction, the only tool available describes
an email, and authority is decided by `requiresApproval()` in code. The system is safe **even when
the detector misses**, which is what makes it acceptable for a regex-based detector to be imperfect.
What the detector adds is that a suspicious email is visibly labelled and put in front of a person.

### Why the mock provider throws instead of guessing

An unregistered request raises `MockResponseNotFoundError`. A mock that quietly fabricates output
would let a broken pipeline pass its own tests, which is worse than having no mock. Its `latencyMs`
is always `0` for the same reason real elapsed time is the most common way a "deterministic" fixture
stops being deterministic.

### Why the CRM interface is split

Spec §15 describes one `CrmAdapter`. It is split into `CrmReader` (built now) and `CrmWriter` (M4),
with `CrmAdapter = CrmReader & CrmWriter` preserving the original shape. The alternative was an
`applyPlan` that throws "not implemented" — a runtime landmine in the one code path where a mistake
writes wrong data to a customer's CRM. A type that says what exists cannot be called by accident.

`applyPlan` is one method rather than six because **atomicity is the adapter's contract**. The local
adapter satisfies it with a transaction. HubSpot cannot — its API has no cross-object transaction —
so that adapter will declare `supportsAtomicity: false`, and the approval policy already requires
approval for multi-action plans on such an adapter. That constraint was designed for before the
integration exists.

## Deviations from the specification

Each was a choice, and each is reversible.

| Spec | Built | Why |
|---|---|---|
| §10 CRM tables have no `deleted_at` | Added to all six | §11 requires soft delete; the two sections disagreed. Unique indexes are partial on `deleted_at IS NULL`, or a soft delete would permanently block reusing an email address. |
| §22 seeds *Acme Commerce* / *ACME Consulting* as the near-duplicate pair | Pair is *Harborview Digital* / *Harborview Media*; Acme Commerce is absent | E-01 (the hero lead) requires Acme Commerce to have **no** CRM match. Both could not be true. |
| §25 lists `dotenv` among the dependencies | Not used | Node 24 ships `process.loadEnvFile()`. One fewer dependency (NFR-9). |
| §15 one `CrmAdapter` | `CrmReader` + `CrmWriter` | See above — no throwing stubs on the write path. |
| §25 lists `@anthropic-ai/sdk` | Installed in M1 | UNDERSTAND is the first stage that can call it. Still not the default — `mock` is (D3). |
| §7 groups `timeline` with the numeric-evidence fields | Timelines accept temporal *words* too | Requiring a digit discarded "before the November peak", a correct extraction. That kind of false positive teaches people to distrust the validator. Budgets still require a number. |
| §7's scoring table has no rule that fires for E-04 | Added `distinctive_token` at 0.65 | Spec §22 requires E-04 to be a conflict, but under §7's own rules it produces nothing: full-string trigram similarity between "harborview group" and "harborview digital" is 0.44, far below the 0.88 fuzzy threshold. At 0.65 the rule lands in the conflict band, so it can never auto-link — the most it can do is put the question to a person. |
| §7's ActionPlan has no field for *why* approval is required | Added `approval_reasons` (migration 006) | §13.3 requires the UI to state the specific trigger, never "this is risky". The policy already computed the reasons; they had nowhere to live. |
| §10 `email_analyses` has one `flags` column | Plus `model_output`, `validation`, `security`, `question_asked` (migration 004) | Four different kinds of knowledge — what the model said, what survived validation, what code changed, what security found — have to stay separable, or "why did it ignore my budget?" has no answer. |

## Dependencies

**Server runtime: three.** `express`, `pg`, `@anthropic-ai/sdk`. (Spec budget: ≤ 4.)
**Server dev:** `typescript`, `oxlint`, and three `@types` packages.
**Web:** `react`, `react-dom` + Vite, Tailwind, TypeScript, oxlint, types.

No test framework, no HTTP-test client, no schema-validation library, no ORM, no migration framework,
no logging library, no router. Each was considered and each would have replaced something that is
forty lines here.

## Evaluation

**Read this first: every score here is "scored against AI-written gold (Claude-written, not yet human-reviewed)".**
The ten demo emails, the scripted model answers stored beside them, the CRM seed, the evaluation datasets
and the specification they follow were written by Claude (an AI assistant) under the project owner's
direction, and no person has reviewed them yet ([`server/data/demo/PROVENANCE.md`](./server/data/demo/PROVENANCE.md)).
A passing evaluation means the code does what its author expected, not that the expectation was right. Every
evaluation prints that label, and a real-model report records it.

**Six mock evaluations** (`npm run eval:understand`, `eval:resolve`, `eval:decide`, `eval:execute`,
`eval:revise`, `eval:outbound`) run the real pipeline (real sanitisation, validation, provenance checking,
injection detection, matching, rules, approval policy, executor, persistence) with the **mock provider**,
which replays the scripted answers. No key, no spend, byte-identical on every run. They test the code around
the model; **they say nothing about a model**, because the "model" is a fixture. Current results: UNDERSTAND
10/10 (with `hallucinatedFieldRate 0`, `provenanceCompleteness 1`, `injectionContainment 1`, the three that are
absolutes rather than targets), RESOLVE 8/8, DECIDE 7/7, and the three safety suites meet all their thresholds.

**One real-model runner, built and not yet run.** `npm run eval:real` is a **dry run**: it prints the model,
the temperature, the retry limit and how many requests it would make (about 13, up to 23), and calls nothing.
`npm run eval:real -- --go` runs the ten emails through the same pipeline against the real model (Gemini by
default, `--provider anthropic` for Claude), scores them with the same checks, **saves every raw model reply**
with its tokens, latency, finish reason and temperature, and writes a report to `docs/results/`. It stops at once
on a rate-limit or quota error, or when two different emails fail in a row, and retries nothing itself. Its
tests use a scripted stand-in for the model. Until it is run, **no real-model number exists**, and the README,
the case study and the 3D page say so.

**What is measured here and what is not.** The ten emails are both the demo and the evaluation set, so there is no
held-out set, and exactly one of them (E-10) carries a prompt injection. `injectionContainment 1` therefore means
that one email was detected and sent to a person by the deterministic detector, not a rate over many attacks.

## Not built yet

No Gmail, no HubSpot, no email sending, no background workers. The expiry sweep is a callable
command (`POST /api/approvals/expire`) rather than a timer, because the rest of the pipeline is
explicitly triggered too — a scheduler can call it, but nothing here runs on its own.

Authentication was built after this section was first written: session-based operator
authentication (scrypt-hashed password, `httpOnly` `SameSite=Strict` cookies). A public read-only
demo mode (`DEMO_PUBLIC_READONLY`, off by default) exists for anyone hosting their own copy; see
[docs/HOSTING.md](./docs/HOSTING.md). **No instance is hosted;** the app is run locally.

**Approve-with-edits (M4-C) is built.** A reviewer can edit a plan's whitelisted fields before
approving; the edit produces a new decision (v2) with its own approval while the original is kept,
intact, as the paired correction — not overwritten. The same draft guardrails and the same
approval-policy floor apply to the edited version as to the model's original.

**The outbound adapter (M4-D) is built, but only with a deterministic mock provider.** Sending stays
behind two server-side locks, `ALLOW_OUTBOUND_SEND` and `OUTBOUND_PROVIDER`; with both set, an approved
reply reaches the mock sender rather than the outbox's `suppressed` state. `OUTBOUND_PROVIDER=gmail`
is a declared name with no implementation — real email delivery is not built and is not
production-ready.

**The Anthropic provider is implemented and unit-tested against a stub client, but has never been run
against the real API** — no credentials were added and no API credits were spent. Its request
shaping, response parsing and every failure path are covered; what is unverified is the wire contract
itself.

Next: a real outbound provider — a Gmail (or equivalent) implementation of `OutboundSender` behind
`OUTBOUND_PROVIDER`, so `ALLOW_OUTBOUND_SEND` has something beyond the mock to turn on.

## License

[MIT](./LICENSE) © 2026 S Mohammad Syed Sameer.
