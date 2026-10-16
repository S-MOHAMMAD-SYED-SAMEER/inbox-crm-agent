import { startStack } from './lib/stack.ts';

// `npm run demo` (from the repository root, or from `server/` once the
// dashboard has been built)
//
// Runs the whole app locally, in one process tree: reset the demo database to
// its seeded starting state, then serve the API and the built dashboard from one
// origin. It is a wrapper over `npm run reset` and `npm start` — it adds no
// behaviour of its own to the application.
//
// WHY A SEPARATE DATABASE FILE, AND WHY RESET
//
// Every run should open on the same pristine demo — an empty inbox and the
// seeded CRM — because a walkthrough consumes that state. `reset` gives exactly
// that, and it deletes every row, so it is pointed at its own SQLite file
// (`data/demo-local.sqlite`) rather than the development one: running the demo
// can never clear data somebody was working with.
//
// WHY IT SETS THE ENVIRONMENT ITSELF
//
// The server refuses every request without a session, and by design has no
// built-in password: `OPERATOR_PASSWORD_HASH` must be supplied. A fresh clone
// has none, so rather than weaken that default this script makes a throwaway
// password for the run and prints it. It is never written to disk, and a new
// one is made each time.
//
// The rest pins the safe local posture explicitly, because a `.env` left over
// from other work must not be able to point a demo at a real database or a real
// model. A variable already set in the environment wins over `.env` (Node's
// `loadEnvFile` never overrides), so setting them here is enough:
//   - DATABASE_URL empty    → local SQLite, never a hosted database
//   - SQLITE_PATH            → the demo's own file, so a reset cannot touch dev data
//   - LLM_PROVIDER=mock      → deterministic fixtures, no key, no spend
//   - EMAIL_SOURCE=demo      → the ten fixture emails; nothing is read from a mailbox
//   - ALLOW_OUTBOUND_SEND=false → nothing is ever sent
//   - COOKIE_SECURE=false    → browsers refuse Secure cookies over http://localhost

await startStack({ provider: 'mock', tag: 'demo' });
