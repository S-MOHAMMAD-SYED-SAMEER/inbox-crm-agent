# Who wrote the demo data

Everything in this folder, and the evaluation datasets in `../../eval/`, was **written by Claude (an AI
assistant)** under the project owner's direction. **It has had no independent human review.** On 2026-10-17 the three evaluation datasets were reviewed with AI
assistance (Claude) against each email's text, and the changes were approved by Sameer (`GOLD_REVIEW.md`, kept outside the
repository). The emails, scripted answers and CRM seed were not themselves reviewed, except that two scripted answers were
changed to match the review: E-02 now reads the timeline "this year", and E-05 is priority high.

| File | What it is | Written by |
|---|---|---|
| `emails.json` | The ten demo emails (E-01 to E-10), and for each the scripted model answer the mock provider replays (`mockUnderstanding`) and, for four, the scripted reply draft (`mockDraft`) | Claude (AI), not human-reviewed |
| `crm-seed.json` | The fictional CRM the demo starts from: 6 companies, 9 contacts, 4 deals, 5 tasks, 20 activities, 3 notes. Every address is on the reserved `.invalid` domain | Claude (AI), not human-reviewed |
| `../../eval/understand.dataset.json` (10 cases), `resolve.dataset.json` (8), `decide.dataset.json` (7) | The expected outcomes the evaluations are scored against | Claude (AI), from the specification; reviewed with AI assistance (Claude), changes approved by Sameer; not an independent human review. Versions 1.1.0, each case's `goldHistory` says what changed |
| `../../../docs/PROJECT2_INBOX_CRM_SPEC.md` | The specification those expectations follow | Claude (AI), under the owner's direction |

What that means for the numbers:

- An evaluation that passes says the code does what the author of the data expected. It does **not** say the
  expectation was right.
- The scripted model answers are fixtures, so the mock evaluations measure the deterministic code around the
  model, never a model.
- Every evaluation prints, and every real-model report records, the label of the gold it was scored against: **scored
  against gold written by Claude; reviewed with AI assistance (Claude); final decisions approved by Sameer (not an
  independent human review)** for the 1.1.0 datasets, and **scored against AI-written gold (Claude-written, not yet
  human-reviewed)** for the original 1.0.0 ones and for the injection attack set, which was not part of the review.
- The review was done with AI assistance, so it is not independent. Scoring was redone from the saved raw replies with
  the corrections applied (`npm run rescore:real`), next to the old numbers.
