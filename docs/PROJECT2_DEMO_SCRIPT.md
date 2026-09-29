# Project 2 — Inbox-to-CRM Agent — Demo Runbook

**Live demo:** https://inbox-crm-agent.onrender.com

This is the runbook for showing Project 2 to a client. The narrative is not new:
it is §25 of `PROJECT2_SYSTEM_AUDIT.md` ("the strongest demo flow") turned into
something you can hold in one hand, with the states and safety moments taken
from the 153-check local walkthrough (`npm run demo:walkthrough`).

Total running time: **8–12 minutes**. The core story is four minutes; the safety
closers are what actually sell it.

> **Sell the outcome, not the machinery.** Nobody is buying RAG or scrypt. They
> are buying *"leads stop falling through the cracks, and nothing embarrassing
> gets sent in your name."* Every line below is written to that.

---

## 0. Before the call — the warm-up ritual

**Do this 5 minutes before, every time. It is not optional.**

The demo runs on Render's free tier, which **sleeps after ~15 minutes idle**.
A cold first request takes **up to 50 seconds** — measured warm latency is
~0.9 s, so the difference is glaring and it will happen at exactly the wrong
moment.

| When | Do this |
|---|---|
| T-5 min | Open https://inbox-crm-agent.onrender.com and let it load |
| T-4 min | Sign in. Leave the tab open — the session lasts 12 hours |
| T-3 min | Confirm the Inbox is **empty** (see §1). If not, reset — §9 |
| T-2 min | Click once every minute or so to keep it awake |

Optional pre-flight from your machine, which also warms it:

```bash
cd inbox-crm-agent/server
npm run verify:deployment -- https://inbox-crm-agent.onrender.com --auth
```

51 checks. Expect **51 passed, 0 failed, 1 warning** (the warning is the known
CORS allow-list entry and is intentional). Note this ingests the demo emails —
which is fine, but it means you skip the live ingest moment. If you want that
moment, run the reset in §9 afterwards.

---

## 1. Expected starting state

| Screen | Should show |
|---|---|
| Overview | System: Running · Sending replies: **Off** · Sign-in: Required |
| Inbox | **Empty** |
| Deals / Contacts / Companies | 4 / 9 / 6 rows, all badged **Demo data** |
| Approvals | Empty |
| Audit log | Empty |

An empty inbox is the point. The demo *opens* by ingesting; a pre-filled inbox
has skipped the first thing worth showing.

---

## 2. The opening line

> "This is an inbox that reads itself. Every email that arrives gets read,
> matched against your CRM, and turned into a specific proposed action — but
> nothing consequential happens until a person says yes. Let me show you."

Click **Inbox** → **Ingest**.

Ten emails appear. Then click **Understand**, **Resolve**, **Decide** in turn,
narrating as each runs:

> "It's reading them, matching them to existing customers, and deciding what to
> do with each one."

**What to point at when it settles:** the emails did not all end up in the same
place. Some are waiting for approval, two are already finished, three are
flagged for a person.

---

## 3. The hero lead — e01, "Shopify AI chatbot project"

The money path. Open it from the Inbox.

### 3a. What it read

> "It classified this as a sales enquiry with high confidence. But look at
> this —"

**Point at the extracted fields.** Every one quotes the sentence it came from.

> "It didn't summarise. It cited. Each of these is linked to the exact sentence
> in the customer's email that it came from. If it can't point at the words, it
> doesn't record the field."

*This is the moment that lands. Do not rush it.*

### 3b. What it matched

> "It checked your CRM before doing anything — the score and the reason are both
> shown in plain English, not as a confidence number nobody can audit."

### 3c. What it proposes

> "Six actions: create the company, the contact, the deal, a follow-up task, and
> a drafted reply."

**Point at the approval reason.**

> "And it's telling you *why* a human is needed — not 'this is risky', but the
> specific action that triggered it. Sending an email and creating a deal are
> consequential, so they always need you."

### 3d. Edit the reply — the revision story

Open the drafted reply and **change something** (a sentence, the greeting).
Submit the revision.

> "You're not stuck with what it wrote. Edit it and it keeps both versions."

**Show the change summary and the history.**

> "Revision 1 was the AI's, and it's been superseded — not deleted. Revision 2
> is yours and it's what's waiting for approval. Nothing is rewritten behind
> you, and the diff between the two is the most valuable data this system
> produces: it's a labelled record of exactly where the model was wrong, in
> your business's own language."

### 3e. Approve and run

Click **Approve**.

> "Five CRM records, created in one transaction. If any one of them failed,
> none of them would have happened."

**Then point at the outbox:**

> "And the reply is sitting here marked **suppressed**. It was written, it was
> approved, and it was *not sent*. Outbound sending is switched off at the
> server, and there is no button on this screen that can turn it on."

---

## 4. What it handled alone — e05 and e09

Back to the Inbox.

**e05, "Checkout step failing on mobile"** — state **Done**:

> "This one never came to you. It's a support request from an existing
> customer — log the activity, schedule a follow-up. Nothing consequential, so
> it just did it. That's the volume you stop touching."

**e09, "Your website is losing traffic"** — state **Archived as noise**:

> "Cold outreach. Archived, no CRM record. It didn't pretend this was a lead."

---

## 5. When it isn't sure — e04 and e08

**e04, "Reporting work for Harborview"** → *Needs a person · more than one CRM
record could be the right one*

> "Two companies in your CRM could be this sender. It found both, and instead of
> picking one it stopped and asked. A wrong CRM merge is expensive and quiet —
> this is the system refusing to guess."

**e08, "Following up"** → *Needs a person · the request could be read more than
one way*

> "Genuinely ambiguous. It says so rather than inventing an interpretation."

---

## 6. The security closer — e10

**This is the moment that closes deals. Save it for last.**

Open **e10, "Urgent order - please confirm pricing"**. State: *Needs a person ·
the email may be trying to give the assistant instructions*.

**Scroll to the red panel.**

> "This email contains hidden instructions aimed at the AI — telling it to ignore
> its rules, approve itself, and not mention it to you."

**Point at each finding** — each says in plain English what the sender tried:
cancelling prior instructions, impersonating a system message, asking to skip
approval, asking to hide it from the operator. Each quotes the text it found.

**Then the headline underneath:**

> "Caught by a security check that runs on every email — *before* the AI is asked
> for its opinion. So it does not depend on the AI noticing. Here, the AI
> *didn't* notice. It was caught anyway."

> "Nothing was executed. No CRM record. It went to a person."

---

## 7. The guardrail that stops a person

Open any email with a drafted reply and **edit it to include a specific price**
("we can do this for $500"). Submit.

> "The content checks don't only police the AI. They police me too. I'm a human
> with approval rights and it still won't let a price out of the door, because
> quoting a number is not something this system is allowed to do on your behalf."

---

## 8. The audit trail

Open **Audit log**.

> "Every decision, in order, in plain English. Who did what — the assistant, a
> person, or the system — and what came of it. If a customer ever asks why they
> got a particular reply, the answer is here, and it can't be edited: the trail
> is append-only."

**Closing line:**

> "Nothing here required anyone to watch an inbox. And nothing consequential
> happened without someone saying yes."

---

## 9. After the demo — reset

A full demonstration **consumes the demo state**. Emails reach terminal states,
approvals settle, and agent-created CRM rows accumulate. Reset before the next
client, or they will see a used system with the best moment already spent.

**One-time setup** (pins the target so the reset can never wander):

```bash
cd inbox-crm-agent/server
npm run demo:reset -- --show-identity     # prints a fingerprint, writes nothing
```

Set `DEMO_RESET_TARGET` to that value in your local `server/.env`.

**After each demo:**

```bash
npm run demo:reset -- --production              # dry run: shows what it WOULD delete
npm run demo:reset -- --production --confirm    # does it
```

It ends with **PRISTINE — ready for a demonstration**. Re-check §1 before the
next call.

**A dry run is the default** — without `--confirm` nothing is written. The reset
refuses if the target is not the pinned database, if the declared target does not
match the actual connection, or if it finds any row it does not recognise as
demo data. It aborts rather than guessing.

---

## 10. Recovery — when something goes wrong mid-demo

| Symptom | Cause | What to do |
|---|---|---|
| First page takes ~50 s | Free-tier cold start | Keep talking. Warm up next time (§0) |
| "That did not match" on sign-in | Wrong password | The session lasts 12 h — sign in *before* the call |
| A screen shows "Could not load" | Instance went to sleep mid-demo | Click **Try again**; it wakes in seconds |
| Inbox already full at the start | A previous demo, or `verify:deployment --auth` | Reset (§9). If mid-call, skip Ingest and open e01 directly |
| Approvals queue already settled | Previous demo | Reset (§9). Mid-call, pivot to the audit trail and e10 |
| Sign-in refuses repeatedly | Login is rate limited to 10/min | Wait 60 seconds |

**If the deployment is unreachable entirely**, run the whole story locally:

```bash
cd inbox-crm-agent/server && npm run demo:walkthrough
```

153 checks covering the same journey. Not as good as clicking through it, but it
proves every claim above in front of the client.

---

## 11. What this demo does NOT show — say so if asked

Being straight about the edges is more persuasive than dodging.

- **Outbound email is off.** Replies are drafted, approved and held. Turning it
  on is two independent switches, deliberately.
- **Gmail and HubSpot are not connected.** The adapters are declared, not
  implemented. The demo mailbox is a fixed set of ten messages.
- **The model runs on recorded responses**, so the demo behaves identically every
  time. The same pipeline, validation and guardrails run either way.
- **Automation and Settings screens are not built.** They say so on screen.
- **Free-tier hosting** — hence the cold start.

---

## Manual browser verification — REQUIRED BEFORE FIRST CLIENT USE

Everything below the API layer is verified automatically (789 tests, 153-check
walkthrough, 51-check live deployment verification). **The rendering is not.**
There is no browser automation in this project — Playwright and jsdom are
excluded by NFR-9 — so the screens themselves have never been machine-checked
against the live deployment.

Walk through §2–§8 once in a real browser and confirm each of these renders:

- [ ] Sign-in works; the app loads after it
- [ ] **Overview** shows plain sentences, not raw config key/value pairs
- [ ] Ingest → Understand → Resolve → Decide each visibly change the Inbox
- [ ] Inbox states read as plain English (*Waiting for approval*, *Needs a person*, *Done*, *Archived as noise*) — **never** raw values like `awaiting_approval`
- [ ] e01 extracted fields **highlight the quoted sentence** in the email body
- [ ] The approval reason names a specific action
- [ ] Editing the reply produces a readable before/after diff
- [ ] Revision history shows revision 1 superseded, revision 2 awaiting
- [ ] Approve creates the CRM records and they appear on the CRM screens badged **From the assistant**
- [ ] The outbox says **suppressed / not sent** — and nowhere says "sent"
- [ ] e10's red panel shows plain-English findings with **no internal rule identifiers** (`instruction_override` etc. must not appear)
- [ ] The price guardrail blocks a human edit and explains why
- [ ] Audit log reads as sentences, not event codes
- [ ] It is usable at laptop width without horizontal scrolling

Anything that fails here is a demo blocker — fix before the first client call,
not after.
