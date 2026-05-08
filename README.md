# threadbeat

`threadbeat` is a TypeScript server for running deterministic heartbeat prompts
through a long-lived server-side Pi agent session.

The current prototype is intentionally small: one HTTP server, one SQL database,
one scheduler loop, and one shared Pi runtime backed by DeepSeek. It is a
control-plane experiment for agents that need both interactive terminal access
and timed prompts that re-enter the same server-side agent over time.

Current shape:

- Fastify JSON API
- raw SQL against libSQL/Turso
- one background scheduler loop
- one shared in-process Pi SDK session
- DeepSeek through `DEEPSEEK_API_KEY`
- repo-relative markdown files for heartbeat `contents`
- terminal CLI/TUI commands for sending, listening, inspecting, and controlling
  heartbeats

Current non-goals:

- no Modal/multi-agent runtime yet
- no on-device daemon yet
- no browser/CUA bridge yet
- no durable interactive chat transcript yet

## Local run

Copy the example env first:

```bash
cp .env.example .env
```

For API-only development with no model calls:

```bash
npm install
THREADBEAT_PI_DRY_RUN=1 npm run dev
```

For live execution, set `DEEPSEEK_API_KEY` in `.env` and either unset
`THREADBEAT_PI_DRY_RUN` or set it to `0`.

Useful env:

- `DEEPSEEK_API_KEY`: DeepSeek key used by Pi
- `THREADBEAT_DB_URL`: libSQL URL, defaults to `file:.threadbeat/threadbeat.db`
- `THREADBEAT_REPO_ROOT`: markdown root, defaults to this repo
- `THREADBEAT_POLL_SECONDS`: scheduler interval, defaults to `10`
- `THREADBEAT_MAX_DUE_PER_POLL`: due heartbeat batch size, defaults to `5`
- `THREADBEAT_RUN_TIMEOUT_SECONDS`: per-heartbeat Pi run timeout, defaults to `300`
- `THREADBEAT_PI_DRY_RUN`: set `1` to skip Pi calls
- `THREADBEAT_PI_DRY_RUN_DELAY_MS`: optional dry-run delay for timeout testing
- `THREADBEAT_PI_PROVIDER`: defaults to `deepseek`
- `THREADBEAT_PI_MODEL`: defaults to `deepseek-v4-flash`
- `THREADBEAT_LOG_REQUESTS`: Fastify request logging, defaults to `1`

Heartbeat `provider` and `model` default to `THREADBEAT_PI_PROVIDER` and
`THREADBEAT_PI_MODEL` when omitted. In v0.2 these fields are persisted on the
heartbeat and copied into run records; the shared Pi runtime itself is still one
configured session.

Runtime reset lifecycle events are written to `heartbeat_events` with
`source: "runtime"` so resets are visible without terminal logs.

## Runtime Memory

The current server uses one shared, long-lived Pi `AgentSession`.

- Each heartbeat tick creates a separate `heartbeat_runs` row.
- Heartbeat prompts and interactive CLI messages are sent to the same Pi session.
- Calls are serialized by the runtime lock.
- The Pi session is only disposed on server shutdown, manual reset, or automatic
  reset after runtime failure.

This means SQL run records are separate, but model context is shared. Use
`npm run cli -- reset` when you want to clear the current hosted Pi session.
Interactive sends support `--stateless` for a one-off isolated Pi session that
does not read from or write to the shared hosted Pi conversation. Future
heartbeat runtime modes should make this explicit: shared, per-heartbeat, or
stateless/reset-each-run.

## Soak Test

Use the soak harness for the v0.2 repeat-run gate. It defaults to a one-hour
dry-run against a temporary DB and repo root:

```bash
npm run soak
```

Useful soak env:

- `THREADBEAT_SOAK_SECONDS`: duration, defaults to `3600`
- `THREADBEAT_SOAK_CADENCE_SECONDS`: heartbeat cadence, defaults to `5`
- `THREADBEAT_PI_DRY_RUN`: defaults to `1`; set `0` for live Pi/DeepSeek
- `THREADBEAT_SOAK_KEEP_ARTIFACTS`: set `1` to keep the temp DB/repo for event-log review

## API Smoke

Use the API smoke check against the in-process app or a deployed Railway URL.
By default it creates a session, creates a heartbeat, waits for cadence, and
executes one scheduler pass.

```bash
npm run smoke:api
THREADBEAT_BASE_URL=https://your-railway-url npm run smoke:api
```

Set `THREADBEAT_API_SMOKE_RUN_HEARTBEAT=0` for a cheap create-only check.

## CLI and TUI

The CLI talks to the server. It does not start Pi or DeepSeek locally unless
you explicitly point it at a local server.

```bash
npm run cli -- status
npm run cli -- status --table
npm run cli -- listen
npm run cli -- send "Say only: hello"
npm run cli -- send --stateless "Say only: isolated hello"
npm run tui
```

By default, `npm run cli` and `npm run tui` target
`http://127.0.0.1:8000`. Override the target with `THREADBEAT_BASE_URL`.

```bash
THREADBEAT_BASE_URL=https://your-railway-url npm run cli -- listen
THREADBEAT_BASE_URL=https://your-railway-url npm run cli -- send "hosted test"
```

Heartbeat operations are also available through the CLI:

```bash
npm run cli -- sessions create "operator"
npm run cli -- heartbeats create --session <session_id> --title "loop" --cadence 60 --contents contents/file.md
npm run cli -- heartbeats pause <heartbeat_id>
npm run cli -- heartbeats resume <heartbeat_id>
npm run cli -- heartbeats run-now <heartbeat_id>
npm run cli -- heartbeats run-now <heartbeat_id> --preserve-cadence
npm run cli -- heartbeats deactivate <heartbeat_id>
npm run cli -- heartbeats list --table
npm run cli -- heartbeats runs <heartbeat_id> --table
npm run cli -- heartbeats runs <heartbeat_id> --follow --poll 2
npm run cli -- events --heartbeat <heartbeat_id> --limit 20 --table
npm run cli -- events --heartbeat <heartbeat_id> --limit 20 --follow --poll 2
```

JSON remains the default output for scripts. Add `--table` to status, sessions,
heartbeats, runs, or events commands for compact terminal output.
Use `--follow` on runs or events to poll until stopped; pass `--count <n>` for
bounded checks.
By default, `run-now` uses scheduler semantics and advances `last_tick` and
`next_tick`. Add `--preserve-cadence` to run immediately without changing the
existing schedule.
`pause` and `deactivate` stop future scheduler claims but do not cancel an
already-active Pi run in v0.4; active runs finish and are visible through
`runs` and `events`.

See `docs/tui-control-plane-plan.md` for the staged terminal control-plane plan.

## Stripe Projects hosting

The hosted prototype has used Stripe Projects to provision Turso and Railway.
This repo does not commit Stripe Projects local state or vault/cache files.

```bash
stripe projects init --yes --accept-tos
stripe projects add turso/database --accept-tos --yes
stripe projects add railway/hosting --accept-tos --yes
stripe projects env --pull
```

The server reads Stripe Projects' pulled Turso env directly:
`TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. `THREADBEAT_DB_URL` and
`THREADBEAT_DB_AUTH_TOKEN` remain supported overrides.

Do not commit `.env`, `.projects/state*.json`, `.projects/cache`, or
`.projects/vault`.

## Railway Deploy

Railway uses `railway.json`:

- build: `npm run build`
- start: `npm run start`
- health check: `GET /health`
- Node: `>=22`

Required hosted env:

- `DEEPSEEK_API_KEY`
- `TURSO_DATABASE_URL` or `THREADBEAT_DB_URL`
- `TURSO_AUTH_TOKEN` or `THREADBEAT_DB_AUTH_TOKEN`
- `THREADBEAT_REPO_ROOT=/app`
- `THREADBEAT_PI_DRY_RUN=0`

Recommended hosted env:

- `THREADBEAT_POLL_SECONDS=10`
- `THREADBEAT_MAX_DUE_PER_POLL=1`
- `THREADBEAT_RUN_TIMEOUT_SECONDS=300`
- `THREADBEAT_LOG_REQUESTS=1`

After deploy:

```bash
THREADBEAT_BASE_URL=https://your-railway-url npm run smoke:api
```

## API

- `GET /health`
- `GET /api/sessions`
- `POST /api/sessions`
- `GET /api/heartbeats`
- `GET /api/heartbeats/due`
- `GET /api/heartbeats/:id`
- `POST /api/heartbeats`
- `PATCH /api/heartbeats/:id`
- `POST /api/heartbeats/:id/pause`
- `POST /api/heartbeats/:id/resume`
- `POST /api/heartbeats/:id/run-now`
- `POST /api/heartbeats/:id/tick`
- `GET /api/runs`
- `GET /api/runtime/pi`
- `POST /api/runtime/pi/reset`
- `GET /api/runtime/pi/messages/listen`
- `POST /api/runtime/pi/message/stream`
- `POST /api/scheduler/run-once`
