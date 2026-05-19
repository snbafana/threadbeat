# threadbeat

Threadbeat is currently a minimal Daytona-backed task substrate.

It is intentionally not an agent framework yet. V1 proves the smallest useful
control-plane primitives:

- `tasks`: queued JSON command specs and execution state
- `events`: ordered task output and lifecycle stream
- Daytona sandboxes: ephemeral execution environments
- Postgres: durable task/event storage

No Pi runtime, heartbeat scheduler, durable agent repo, artifacts table, replay
system, TUI, or orchestration DAG is part of this cut.

## Local Setup

```bash
npm install
cp .env.example .env
```

Required for the server:

```bash
DATABASE_URL="postgresql://postgres.pvvmbkhdyljnkkstsfzk:[YOUR-PASSWORD]@aws-1-us-east-1.pooler.supabase.com:6543/postgres"
DAYTONA_API_KEY=...
```

The DB layer uses Drizzle with `postgres` and disables prepared statements for
Supabase pooler compatibility.

Before running the server against a fresh database, push the Drizzle schema:

```bash
npm run db:push
```

Optional tuning:

```bash
THREADBEAT_HOST=127.0.0.1
THREADBEAT_PORT=8000
THREADBEAT_MAX_SANDBOXES=1
THREADBEAT_COMMAND_TIMEOUT_SECONDS=120
THREADBEAT_SANDBOX_ENV_ALLOWLIST=THREADBEAT_SMOKE_MARKER
```

Only env vars listed in `THREADBEAT_SANDBOX_ENV_ALLOWLIST` are injected into
Daytona sandboxes.

## Run

```bash
npm run dev
```

The server assumes the Drizzle schema has already been pushed, then exposes:

- `GET /health`
- `POST /api/tasks`
- `GET /api/tasks`
- `GET /api/tasks/:id`
- `GET /api/events?taskId=...&after=...`
- `POST /api/worker/drain-once`

Drizzle schema/config live in `drizzle/schema.ts` and `drizzle.config.ts`.
Useful commands:

```bash
npm run db:generate
npm run db:push
npm run db:studio
```

## Task Spec

`POST /api/tasks` accepts a flexible JSON spec:

```json
{
  "repo": {
    "url": "https://github.com/octocat/Hello-World.git",
    "branch": "master"
  },
  "setup": [{ "cmd": "echo setup", "timeoutSeconds": 30 }],
  "main": { "cmd": "ls -la", "timeoutSeconds": 30 },
  "verify": [{ "cmd": "test -f README", "timeoutSeconds": 30 }]
}
```

`repo` is optional. If present, commands default to `workspace/repo`; otherwise
they default to `workspace`. Individual commands can override `cwd`.

## CLI

The CLI is a smoke driver, not a full operator UI.

```bash
npm run cli -- task create task.json
npm run cli -- task list
npm run cli -- task get <task_id>
npm run cli -- worker drain-once
npm run cli -- events follow --task <task_id>
```

By default it targets `http://127.0.0.1:8000`. Override with
`THREADBEAT_API_URL`.

## Verification

Static local checks:

```bash
npm run typecheck
npm run lint
npm run build
```

HTTP checks require a running server and reachable `DATABASE_URL`:

```bash
npm test
npm run smoke:api
```

Live Daytona checks:

```bash
npm run smoke:daytona
npm run smoke:live
```

The repo matrix is defined in `test/fixtures/repo-matrix.json` and expects a
running server:

```bash
npm run smoke:matrix
```

## Current Daytona Note

The Daytona adapter creates sandboxes from a small image with zsh, bash, git,
node, and npm installed, then executes commands through short-lived Daytona shell
sessions. Keep Daytona execution details inside `src/daytonaProvider.ts` unless
another runtime path is proven necessary by `npm run smoke:daytona`.
