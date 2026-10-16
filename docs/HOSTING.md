# Host your own instance (optional)

**You do not need any of this to try the project.** Run it locally with one command (see "Run it locally" in the
[README](../README.md)). **No instance of this project is hosted for you, and it has never been run in production.**
Everything below is for someone who wants to put their own copy on a server. It is kept because it is built and
tested, not because anything is deployed.

What exists, and what each piece is for:

| Piece | Where | What it does |
|---|---|---|
| Single-origin serving | `server/src/app.ts` (`WEB_DIST_DIR`) | The server serves the built dashboard and the API from one origin, so there is no CORS to configure for your own front end |
| Hosted Postgres | `DATABASE_URL`, `server/src/db/postgres.ts` | A `postgres://` URL switches the driver from the local SQLite file to Postgres (TLS is required unless the URL says `sslmode=`) |
| Proxy awareness | `TRUST_PROXY` | How many reverse proxies sit in front; `0` (default) means none and `X-Forwarded-For` is ignored |
| Secure cookies | `COOKIE_SECURE` | `true` by default; `false` only for plain-HTTP local runs |
| Public read-only demo mode | `DEMO_PUBLIC_READONLY` (off by default) | Anonymous visitors can read an allow-listed set of routes over synthetic data and are granted no session; every mutation still fails with a 401 |
| Demo reset | `npm run demo:reset` | Restores the exact seeded starting state of a database it recognises as demo data; refuses anything else |
| Demo populate | `npm run demo:populate` | Runs the product's own pipeline once against a deployment so the read-only demo has something in it; stops at "decide", approves nothing |
| Production check (local) | `npm run verify:production` | Spawns the server the way a host would, with the built dashboard, and checks 60 properties of that arrangement |
| Deployment check (remote) | `npm run verify:deployment -- https://your-host` | Checks a running deployment from outside, without a credential (add `--auth` for the signed-in checks, which prompt for the password and never print it) |

The four scripts live in `server/scripts/hosting/`; the judgement behind demo reset and populate is in
`server/src/demo/` and is unit-tested.

## A minimal route, in order

1. **A database.** Create an empty PostgreSQL 16 database (any host). Set `DATABASE_URL` for the server. For a Postgres
   without TLS (a local container), add `?sslmode=disable`.
2. **Migrate and seed.** `npm run migrate && npm run seed` against that URL. The seed puts the fictional CRM in; a
   real deployment would not seed it.
3. **Check the driver.** `npm run verify:postgres` against the same URL (55 checks; needs the seed).
4. **Build the dashboard.** `npm run build --prefix web`, and point `WEB_DIST_DIR` at `web/dist` if it is not at its
   default relative path.
5. **Set the operator password.** `npm run hash-password`, and put the result in `OPERATOR_PASSWORD_HASH`. The server
   refuses every request without a session, and there is no built-in password.
6. **Behind a proxy that terminates TLS** keep `COOKIE_SECURE=true` and set `TRUST_PROXY` to the number of hops.
7. **Start it:** `npm start` in `server/` (set `PORT` if the host assigns one).
8. **Check it.** `npm run verify:production` locally first, then `npm run verify:deployment -- https://your-host`.

A model is a separate decision: the keyless `mock` provider runs the whole demo on a host with no key. A real provider
needs its key in the environment (`LLM_PROVIDER=gemini` with `GEMINI_API_KEY`, or `anthropic`), and **every email then costs
real requests**; see the README for what has and has not been run. **Nothing is ever sent**: outbound sending needs two
independent switches and the only sender implemented is a mock.

## What has and has not been verified

- **Run and passing, on a developer laptop:** `verify:production` (60 checks, local single-origin build) and
  `verify:postgres` against a PostgreSQL 16 container (55 checks).
- **Never run against a live remote host:** `verify:deployment` and `demo:populate` are written for a URL and tested with
  stand-ins; no deployment of this project exists to point them at.
- **No platform is claimed.** An earlier version of the docs named a free hosting platform and a hosted database. Neither
  is in use, and neither is endorsed here: any host that runs Node 24 and reaches a Postgres will do.
- **Single process.** The rate limiter is in memory in one process; a second instance would each enforce its own limit.
  This is not a multi-instance design.
- **One shared operator password**, no accounts, no roles.
