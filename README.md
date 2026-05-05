# threadbeat

`threadbeat` is a TypeScript server for deterministic heartbeat prompts over time.

Current shape:

- Fastify JSON API
- raw SQL against libSQL/Turso
- one background scheduler loop
- one shared in-process Pi SDK session
- DeepSeek through `DEEPSEEK_API_KEY`
- repo-relative markdown files for heartbeat `contents`

## Local run

```bash
npm install
THREADBEAT_PI_DRY_RUN=1 npm run dev
```

Use dry-run mode for API and scheduler testing without model calls. For live execution, remove `THREADBEAT_PI_DRY_RUN=1` and make sure `DEEPSEEK_API_KEY` is present in `.env`.

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

## Stripe Projects hosting

Turso is provisioned through Stripe Projects for this project. Railway is linked,
but hosting provisioning requires a GitHub repository in `owner/repo` format.

```bash
# Already completed:
# stripe projects add turso/database --accept-tos --yes --config '{"name":"threadbeat","location":"aws-us-east-1"}'

# Complete after this repo has a GitHub remote:
stripe projects add railway/hosting --accept-tos --yes --resource-info '{"source_type":"GitHub repository"}'
stripe projects add railway/hosting --accept-tos --yes --resource-info '{"repo":"OWNER/REPO","branch":"main"}'
stripe projects env --pull
```

After pulling env, set `THREADBEAT_DB_URL` and `THREADBEAT_DB_AUTH_TOKEN` from
the pulled Turso env names if Stripe Projects does not map them directly.

## Railway Deploy

Railway uses `railway.json`:

- build: `npm run build`
- start: `npm run start`
- health check: `GET /health`
- Node: `>=22`

Required hosted env:

- `DEEPSEEK_API_KEY`
- `THREADBEAT_DB_URL`
- `THREADBEAT_DB_AUTH_TOKEN`
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
- `POST /api/heartbeats/:id/tick`
- `GET /api/runs`
- `GET /api/runtime/pi`
- `POST /api/runtime/pi/reset`
- `POST /api/scheduler/run-once`
