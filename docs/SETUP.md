# Setup guide

This takes you from nothing installed to the Inbox-to-CRM Agent running on your machine, first with no key, then (optionally)
against the real Gemini model. It is written for Windows first, with notes for macOS and Linux where they differ.

**How these steps were checked.** I ran every command below from a **fresh clone** on Windows 11 (Git Bash and PowerShell) with
Node 24.19 and npm 11.17: `npm install` in `server/` and `web/`, `npm test` in both (918 and 185 tests pass), all six mock
evaluations (each ends "All thresholds met."), `npm run demo` (health check, sign-in with the printed password, a wrong
password refused with 401), `npm run verify:browser` (headless Chrome, owner and guest), and `npm run live` with no key (it
refuses to start). **No model request was made**: the real-model step is described from the code and from the project's own
recorded runs, not re-run for this guide. The macOS and Linux notes are the usual equivalents and were **not run on those
systems**. CI runs the tests, the evaluations, an `npm audit` and the real-browser check on Linux (Node 24) for every push.

What you will have at the end: the dashboard at <http://localhost:3100>, the tests and the mock evaluations passing, and
(optionally) the same app reading the ten demo emails with a real model on the free tier.

- [1. Install the prerequisites](#1-install-the-prerequisites)
- [2. Get the code](#2-get-the-code)
- [3. Run the demo (no key)](#3-run-the-demo-no-key)
- [4. Try the guest demo](#4-try-the-guest-demo)
- [5. Run it on the real model (free Gemini key)](#5-run-it-on-the-real-model-free-gemini-key)
- [6. Run the tests and the evaluations](#6-run-the-tests-and-the-evaluations)
- [7. What to try in the app](#7-what-to-try-in-the-app)
- [8. Troubleshooting](#8-troubleshooting)
- [9. Code tour: one email, start to finish](#9-code-tour-one-email-start-to-finish)

## 1. Install the prerequisites

You need Git and Node.js. Nothing else: no database server, no Docker, no Python, no account and no key for the demo.

**Node.js 24 or newer.** Download the current LTS from <https://nodejs.org> or use your package manager. The code runs
TypeScript directly and uses the built-in `node:sqlite`, which is why 24 is the floor (the `engines` field in the root
`package.json` says the same). Check:

```
node -v
npm -v
```

`node -v` must print `v24.0.0` or higher.

**Chrome or Chromium (optional).** Only for `npm run verify:browser`, which drives a headless browser through the real app. If
Chrome is not in its usual place, set `CHROME_PATH` to the executable.

## 2. Get the code

```
git clone https://github.com/S-MOHAMMAD-SYED-SAMEER/inbox-crm-agent.git
cd inbox-crm-agent
```

The repository has two projects: `server/` (the API, the pipeline and the scripts) and `web/` (the dashboard). The one-command
demo below installs both for you. The scripts are defined in [`server/package.json`](../server/package.json) and
[`web/package.json`](../web/package.json).

## 3. Run the demo (no key)

From the repository root:

```
npm run demo
```

This installs the dependencies, builds the dashboard, resets a local SQLite database to the seeded demo CRM, and starts the
app. You should see:

```
[demo] Provider: mock (scripted replies, no model, no key).
[reset] cleared all data.
[reset] reseeded: { companies: 6, contacts: 9, deals: 4, tasks: 5, activities: 20, notes: 3 }
[reset] demo is back to its starting state.

[demo] Open http://localhost:3100
[demo] Sign in with this password (made for this run, local only): <a short random string>

[server] Listening on port 3100 { database: 'sqlite', llmProvider: 'mock', migrationsApplied: 10 }
```

Open <http://localhost:3100> and sign in with the password printed in the terminal. It is made fresh for every run and is
never stored in the browser, so if you lose it, stop the app (**Ctrl+C**) and run `npm run demo` again.

The `mock` provider is **not a model**. It replays scripted answers for the ten demo emails, so every run behaves the same
and nothing costs anything. Everything around it (the checks on its answers, the matching, the rules, the approval gate)
is the real code. **No real email is ever sent**: by default an approved reply stops in the outbox as `suppressed`.

The demo starts at `manual` autonomy, so every plan waits for you to approve it.
`AUTONOMY_LEVEL=assisted npm run demo` starts it at `assisted`, where only the harmless plans (archiving the spam, logging a
support request) run on their own.

To use another port, set `PORT` (for example `PORT=3101 npm run demo` in Git Bash or macOS/Linux, or
`$env:PORT=3101; npm run demo` in PowerShell).

## 4. Try the guest demo

On the sign-in page, **Try the demo — no sign-in** gives you a private copy of the demo, with no password. Run the whole flow
yourself; **Start over** puts it back at the beginning and **Leave the demo** ends it. The answers are **replayed from a
recorded real run** of `gemini-3.5-flash-lite`, so no model is called even when the app itself is running on a real key, and
no real email is ever sent. It works the same way with `npm run demo` and with `npm run live`. `GUEST_DEMO=false` turns it off. The
details are in [ARCHITECTURE.md](./ARCHITECTURE.md).

## 5. Run it on the real model (free Gemini key)

**Get a key.** Go to <https://aistudio.google.com/apikey>, sign in with a Google account and create an API key. The free tier
is enough. The default model is `gemini-3.5-flash-lite`.

**Put it in `server/.env`.** From the `server` folder:

```powershell
# Windows (PowerShell)
Copy-Item .env.example .env
```

```
# macOS / Linux
cp .env.example .env
```

Open `server/.env` in an editor and fill in one line, with no quotes and no spaces around the `=`:

```
GEMINI_API_KEY=your-key-here
```

Leave the rest as it is. Every other variable is optional and documented in the file.

> **Never commit this file or paste the key anywhere public.** `.env` is listed in the repository's `.gitignore`, so
> `git status` will not show it, and it should stay that way. If a key ever lands in a commit, treat it as leaked: delete
> it in Google AI Studio and make a new one.

**Run it.** From the `server` folder (build the dashboard once first with `npm run demo`, or `npm run build --prefix ../web`):

```
npm run live
```

It prints the provider, the model and the temperature, and whether the key is set (never the key itself), then starts the same
app on <http://localhost:3100>. With no key it refuses to start and says so.

**What it costs.** Each email you analyse is one model request, and each reply that is drafted is one more. A full pass over the
ten demo emails is about **13 requests** (10 to read, up to 3 to draft), at most about 16. The free tier allows roughly 10 to
15 requests a minute for this model, and the **Analyse waiting emails** button reads every waiting email back to back with no
pause. In a recorded run on 2026-10-18 the ten went through without a rate limit, but it is not guaranteed. If you hit one,
wait a minute and click again, and click through the steps (Ingest, Analyse, Match, Decide) one at a time rather than
scripting them. The button names how many emails it will read before you click it.

Sending stays off in every mode: there is no real email provider, so an approved reply is only ever written and held.

## 6. Run the tests and the evaluations

From the repository root (after the installs in step 2, which `npm run demo` also does):

```
cd server
npm test              # 918 tests, offline, no key
npm run typecheck
npm run lint
npm run eval:understand
npm run eval:resolve
npm run eval:decide
npm run eval:execute
npm run eval:revise
npm run eval:outbound   # each prints its results and ends "All thresholds met."
cd ../web
npm test              # 185 tests
npm run build
```

The six evaluations use the **mock** provider, so they test the code around a model, not a model. What the real model scored is
in [docs/results/RESULTS_SUMMARY.md](./results/RESULTS_SUMMARY.md), with its limits. Re-running that needs a key and about 39
requests: `npm run eval:real` is a dry run that prints the request count first, and `npm run eval:real -- --go --repeats 3`
makes them.

`npm run verify:browser` (from `server/`, needs Chrome and a built dashboard) starts the app, signs in in a real headless
browser, runs the flow as the owner and as a guest, and checks the layout at 1280, 1440 and 375 px. It ends with
`RESULT: the documented first run works in a real browser.`

## 7. What to try in the app

1. **Inbox**: click **Ingest new email** (ten invented emails), then **Analyse waiting emails (10)**, **Match to CRM** and
   **Decide**. Each step fills in more of the table.
2. Open **Priya Nair — Cost for automating our client onboarding**. Hover **Company**, **Budget** or **Timeline** on the
   right: the sentence each came from lights up in the email on the left. The **Validation** note says what the code did to
   the model's answer.
3. **Approvals**: **Show what will happen** on a plan to see the before and after, then **Approve and carry out**. Open the
   email afterwards to see the audit timeline. The reply is held, never sent.
4. **Approvals → Needs a person**: the email that hides an instruction for the AI can only be archived. The unclear ones can
   be let through (**Continue to CRM matching**); if matching then finds more than one possible record, **Choose the record**
   lists them, with **None of these — create new records**.
5. **Overview** and **CRM → Contacts / Companies / Deals / Tasks** show the records the approvals wrote.

With the mock provider (step 3) the answers are scripted, so they are not a real model's and will differ in detail from a
`npm run live` run.

## 8. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `node -v` prints something below v24 | Install Node 24 or newer. The code runs TypeScript directly and needs it. |
| `npm warn allow-scripts ... @google/genai ... protobufjs` after `npm install` | Harmless on a newer npm: it lists install scripts it did not run. Nothing here needs them. |
| `[live] Not starting: GEMINI_API_KEY is not set.` | Put the key in `server/.env` (step 5) or set it in the shell. `npm run demo` needs no key. |
| The key is in `.env` but `live` says it is not set, or uses a different key | A key already set in your Windows environment can win over the file. Check, and remove it for the session (the commands were run on a throwaway variable): `Get-ChildItem Env:GEMINI_API_KEY` then `Remove-Item Env:GEMINI_API_KEY`. In bash, `unset GEMINI_API_KEY`. |
| Sign-in says the password is wrong | The password is new on every run, and printed in the terminal that started the app. Copy it from there (or restart the app). |
| The page is blank or "The dashboard is not built" | Build it once: `npm run build --prefix web` from the repository root, or just run `npm run demo`. |
| Something else already answers on port 3100 | On Windows a second copy of the app can start on a port that is already in use **without an error**, and requests may reach either one. Check with `netstat -ano | findstr :3100`, stop the old process, or use another port (`PORT=3101`). |
| A rate-limit or quota error from the real model (429) | Wait a minute and click the step again. Each click only reads emails that are still waiting. |
| `npm run verify:browser` says no Chrome was found | Install Chrome, or set `CHROME_PATH` to its executable. |
| `npm run reset` refuses to run | It only clears a database it recognises as demo data. That is deliberate. |

## 9. Code tour: one email, start to finish

The pipeline is **ingest → understand → resolve → decide → approve → execute**. "The model proposes, deterministic code
disposes, a human authorises." In `server/src/`:

1. **Ingest**: `agent/ingest/` reads the demo emails (fixtures in `data/demo/`).
2. **Understand**: `agent/understand/` asks the model for a structured reading, then the code checks it: a name, title or
   company must be written in the email (the verbatim check), a suspected injection is flagged, and the category and
   confidence are corrected where the code disagrees. This is where a value the email does not support is discarded.
3. **Resolve**: `agent/resolve/` matches the sender and the company against the CRM by address, domain and name, and says so
   when two records are too close to call.
4. **Decide**: `agent/decide/rules.ts` holds the deterministic rules (R-01 and onwards) that turn a reading into a plan. The
   model only drafts the reply text, after the plan is final. `agent/policy/` decides whether the plan needs a person.
5. **Approve**: `handlers/emails.ts` and `agent/approve/` hold the approval queue, edits, rejection with a reason and the
   expiry sweep.
6. **Execute**: `agent/execute/executor.ts` applies an approved plan in one transaction, idempotently, re-checking the approval
   from the stored record, with before and after snapshots.
7. **Guest mode**: `guest/` holds the per-guest in-memory sandbox, the recorded-run replay and its limits.
8. **Dashboard**: `web/src/screens/` (Inbox, email detail, Approvals, the CRM screens) and `web/src/components/`.

The design decisions and their failure modes are in the [README](../README.md) and [ARCHITECTURE.md](./ARCHITECTURE.md); the full
specification is [PROJECT2_INBOX_CRM_SPEC.md](./PROJECT2_INBOX_CRM_SPEC.md).
