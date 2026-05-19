# threadbeat

Threadbeat is currently a minimal Daytona-backed task substrate.

It is intentionally not an agent framework yet. V1 proves the smallest useful
control-plane primitives:

- `tasks`: queued JSON command specs
- `runs`: one execution attempt for a task
- `events`: lifecycle and command output rows
- Daytona sandboxes: ephemeral execution environments
- Postgres: durable task/run/event storage

No Pi runtime, heartbeat scheduler, durable agent repo, artifacts table, replay
system, TUI, or orchestration DAG is part of this cut.

## Local Setup

```bash
npm install
cp .env.example .env
```

Required for the server:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/threadbeat
DAYTONA_API_KEY=...
```

Optional tuning:

```bash
THREADBEAT_HOST=127.0.0.1
THREADBEAT_PORT=8000
THREADBEAT_MAX_SANDBOXES=1
THREADBEAT_COMMAND_TIMEOUT_SECONDS=120
THREADBEAT_RUN_TIMEOUT_SECONDS=600
THREADBEAT_SANDBOX_ENV_ALLOWLIST=THREADBEAT_SMOKE_MARKER
```

Only env vars listed in `THREADBEAT_SANDBOX_ENV_ALLOWLIST` are injected into
Daytona sandboxes.

## Run

```bash
npm run dev
```

The server bootstraps `schema/bootstrap.sql`, then exposes:

- `GET /health`
- `POST /api/tasks`
- `GET /api/tasks`
- `GET /api/tasks/:id`
- `GET /api/runs`
- `GET /api/runs/:id`
- `GET /api/events?taskId=...&runId=...&after=...`
- `POST /api/worker/drain-once`

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

Cheap local checks:

```bash
npm test
npm run smoke:api
npm run typecheck
npm run lint
npm run build
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

The Daytona `executeCommand` SDK path currently tries to execute through a zsh
path that is missing in the default TypeScript sandbox. The adapter therefore
runs command specs through Daytona `codeRun` with a small shell wrapper. Keep
that workaround inside `src/daytonaProvider.ts` unless Daytona command execution
is proven fixed.
