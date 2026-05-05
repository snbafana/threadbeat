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

Heartbeat `provider` and `model` default to `THREADBEAT_PI_PROVIDER` and
`THREADBEAT_PI_MODEL` when omitted. In v0.2 these fields are persisted on the
heartbeat and copied into run records; the shared Pi runtime itself is still one
configured session.

Runtime reset lifecycle events are written to `heartbeat_events` with
`source: "runtime"` so resets are visible without terminal logs.

## Stripe Projects hosting

The app is ready for Stripe Projects managed hosting, but Railway and Turso both require provider ToS acceptance before provisioning.

```bash
stripe projects add turso/database --accept-tos --yes --config '{"name":"threadbeat","location":"aws-us-east-1"}'
stripe projects add railway/hosting --accept-tos --yes
stripe projects env --pull
```

After Turso is provisioned, set `THREADBEAT_DB_URL` and `THREADBEAT_DB_AUTH_TOKEN` from the pulled env names if Stripe Projects does not map them directly.

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
