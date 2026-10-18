# Architecture notes

This page covers three things that are easy to get wrong from the code alone: the rule that lets an operator continue an
ambiguous email (R-20), the two kinds of visitor (the owner and a guest), and why a guest never reaches a real model. The
pipeline itself (ingest, understand, resolve, decide, approve, execute) is described in the [README](../README.md).

## R-20: an ambiguous email a person has checked

DECIDE has no plan for an email read as `ambiguous` (rule R-18: "an ambiguous email produces no plan at all"). That is right for an
email nobody has looked at. It left a dead end for one a person had: choosing **Continue to CRM matching** on an ambiguous email
used to end with an empty plan and the email handed straight back to them.

R-20 closes that, and only that. When the audit log says a person checked the email and let it continue
(`human_review_recorded`, action `continue`), an ambiguous email gets a two-action plan:

1. **log an activity**, recording that the email arrived; and
2. **create a task** for a person to look at it.

What it is attached to is the person's decision, never the machine's:

- **No pick** (a plain Continue, nothing to answer): the activity and the task are attached to the email and to nothing else. This holds
  even when the sender matches an existing contact or company: the reading is still ambiguous, so nothing is filed against a person or
  an organisation on the strength of it. (A test proves it, including with a matched sender.)
- **An existing record picked** ("Choose the record", when matching found more than one possible record): the activity and the task
  are attached to the contact and/or company they picked.
- **"None of these, create new records" picked:** R-01 and R-02 add `create_company` and/or `create_contact` for the kinds the CRM has
  no record of, built only from fields that passed the verbatim check and the email's own headers, and the activity and the task are
  attached to those. A pick is recorded with its actor (`match_resolved_by_human`) and only the pick that produced the current match
  counts.

What it deliberately does not do, in every case:

- It never creates a deal, and it drafts no reply, so nothing could be sent.
- It never links two records to each other (R-03 does not apply to an ambiguous email).
- It does not lower the approval requirement. The reading is still ambiguous, so the plan still needs a person to approve it.

Without the person's check, R-18 applies exactly as before, and the mock evaluations are unchanged. "Continue" itself is offered
only when the review reason was an ambiguous reading (`ambiguous_intent`); an email suspected of carrying instructions can only be
archived, and the server enforces that with a 403, not the screen. This rule was approved by the project owner.

## Two kinds of visitor

| | Owner | Guest |
|---|---|---|
| Signs in with | the operator password | nothing: "Try the demo — no sign-in" |
| Session | a row in the database, `inbox_session` cookie | an in-memory registry entry, `inbox_guest` cookie |
| CSRF | `inbox_csrf` cookie, header `x-csrf-token` | `inbox_guest_csrf` cookie, the same header |
| Data | the owner's database (SQLite file or Postgres) | a private in-memory SQLite database, deleted when they leave |
| Model | whichever provider the server is set to (the real one for `npm run live`) | a recorded real run, replayed |
| Sending | off unless the server turns it on | always off, even if the server has it on |

The guest path is separate code with separate cookies. It never creates, reuses, refreshes or clears an owner session; a browser
that is signed in as the owner is refused a guest session (409, no cookie set at all); if a request somehow carries both cookies it
is the owner's; and a guest leaving clears only the guest cookies. Owner sign-in is unchanged.

The role is never taken from a request. The cookie is a random token; the server looks the sandbox up from it, and nothing in a
request names a sandbox or a role, so there is nothing to change to reach someone else's data.

### One sandbox per guest

A sandbox is a brand-new in-memory SQLite database, migrated and seeded with the demo CRM, plus its own recorded-answer provider, its
own copy of the demo email source and its own email and CRM routes built over exactly those. A guest's request is handed to that
router and to nothing else. That is isolation by construction: there is no query in which a guest id could be forgotten, because there
is no shared table, and the owner's database is never opened on a guest's behalf.

Why not the alternatives: a schema per guest in Postgres needs the owner's database, leaves residue after a crash and is slower to
create; a `guest_id` column on every table means one missed `WHERE` leaks data. An in-memory database costs about 21 ms and about
1 MB to create, and a crash or restart cleans up by itself.

The guest router is an explicit allowlist (the email routes and the CRM reads). Anything else is refused with a 403, never passed on to
the owner's routes, so a route added later is private to the owner by default.

**Lifecycle and limits.** A sandbox is deleted on sign-out, after 30 minutes without a request, or after 2 hours at most, whichever
comes first. A sweep runs on a timer and once at start. At most 20 exist at once ("The demo is busy — try again in a few minutes."),
at most 5 new guest sessions start per address per hour, and each guest session is rate limited as its own caller. "Start over"
replaces the sandbox with a fresh seeded one and keeps the session.

**What it cannot do.** A guest cannot reach another guest or the owner, turn sending on, change server settings or call a model.

### Why guests use replay, and what replay replaces

A hosted demo that called a real model would have a cost and an abuse problem: anyone on the internet could spend the owner's quota.
So guests are answered from a recording of a real run (`server/data/replay/recorded-run.json`, built from a saved evaluation report by
`scripts/build-replay-recording.ts`): `gemini-3.5-flash-lite`, 2026-10-17, run 1 of 3, with its model, temperature and prompt versions
stored in the file and shown in the banner.

Replay replaces **only the model call**. Everything else runs live on each replayed answer, exactly as it did on the real one:
the verbatim field check, the follow-up context check, the injection detector, the decide rules (R-12, R-19, R-20 and the rest), the
draft checks and the approval policy. A test proves it by altering the recorded answers (an unwritten company, an injection the
model "missed", a draft that promises a proposal) and showing the live code catches each.

A recorded answer is keyed by **email, step and prompt version**. If a prompt changes, the recorded answer was given to a different
question, so the replay fails with "No recorded answer for this step" and the screen says so. It never replays an old answer and never
makes one up. Asking again ("Analyse again") replays the same recorded answer.

## Where to read more

- Hosting and its limits: [HOSTING.md](./HOSTING.md)
- What the evaluations do and do not show: [`docs/results/RESULTS_SUMMARY.md`](./results/RESULTS_SUMMARY.md)
