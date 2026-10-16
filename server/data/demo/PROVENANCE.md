# Who wrote the demo data

Everything in this folder, and the evaluation datasets in `../../eval/`, was **written by Claude (an AI
assistant)** under the project owner's direction. **No person has reviewed it yet.**

| File | What it is | Written by |
|---|---|---|
| `emails.json` | The ten demo emails (E-01 to E-10), and for each the scripted model answer the mock provider replays (`mockUnderstanding`) and, for four, the scripted reply draft (`mockDraft`) | Claude (AI), not human-reviewed |
| `crm-seed.json` | The fictional CRM the demo starts from: 6 companies, 9 contacts, 4 deals, 5 tasks, 20 activities, 3 notes. Every address is on the reserved `.invalid` domain | Claude (AI), not human-reviewed |
| `../../eval/understand.dataset.json` (10 cases), `resolve.dataset.json` (8), `decide.dataset.json` (7) | The expected outcomes the evaluations are scored against | Claude (AI), from the specification, not human-reviewed |
| `../../../docs/PROJECT2_INBOX_CRM_SPEC.md` | The specification those expectations follow | Claude (AI), under the owner's direction |

What that means for the numbers:

- An evaluation that passes says the code does what the author of the data expected. It does **not** say the
  expectation was right.
- The scripted model answers are fixtures, so the mock evaluations measure the deterministic code around the
  model, never a model.
- Every evaluation prints, and every real-model report records: **scored against AI-written gold (Claude-written,
  not yet human-reviewed)**.
- A human review is planned (a sheet listing every item, with an empty verdict line, is kept by the owner).
  After it, scoring is redone from the saved raw replies, with any corrections applied.
