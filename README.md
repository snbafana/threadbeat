# threadbeat

Threadbeat is a minimal Daytona-backed agent control plane with SQL-backed
thread state.

It is intentionally not an agent framework yet. V1 proves the smallest useful
message-first primitives:

- `agents`: names and ids for GitHub agent repos
- `threads`: durable human-facing continuity for one agent goal
- `messages`: append-only JSON interaction payloads
- `sandboxes`: provider runtime rows attached to a thread and ordered by `index`
- `artifacts`: object-storage pointers for traces, outputs, screenshots, and run bundles
- `heartbeats`: durable timers that append JSON messages to threads
- `events`: ordered thread telemetry

No task table, run table, replay system, TUI, repo mirror, provider registry, or
orchestration DAG is part of this cut. A message starts or resumes work on a
thread; the current goal is inferred from the ordered message set and stored as
`threads.goal_json`.

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

Before running the server against a fresh database, run Drizzle migrations:

```bash
npm exec drizzle-kit migrate
```

Server bind address, worker timing, command timeouts, and sandbox env allowlist
live in `src/config.ts`. Only allowlisted secret env vars are copied into
Daytona sandboxes.

## Run

```bash
npm run dev
```

The API exposes:

- `GET /health`
- `POST /api/agents`
- `GET /api/agents`
- `GET /api/agents/:id`
- `POST /api/threads`
- `GET /api/threads`
- `GET /api/threads/:id`
- `POST /api/threads/:id/messages`
- `GET /api/threads/:id/messages`
- `POST /api/threads/:id/sandboxes`
- `GET /api/threads/:id/sandboxes`
- `POST /api/threads/:id/sandboxes/current/close`
- `POST /api/threads/:id/artifacts`
- `GET /api/threads/:id/artifacts`
- `POST /api/threads/:id/heartbeats`
- `GET /api/threads/:id/heartbeats`
- `GET /api/heartbeats`
- `GET /api/heartbeats/:id`
- `POST /api/heartbeats/drain-due`
- `GET /api/events?threadId=...&after=...`
- `POST /api/worker/drain-once`

## Message-First Thread Flow

Create a thread:

```json
{
  "title": "research agent harness",
  "agentId": "agent_123",
  "goalJson": {
    "text": "Build a repo-backed research agent that can search, save traces, and resume from heartbeats."
  }
}
```

Append human input as JSON:

```json
{
  "role": "human",
  "contentJson": {
    "text": "continue from the latest trace and focus on search tool reliability"
  }
}
```

Heartbeats are scheduled JSON messages:

```json
{
  "title": "continue research loop",
  "cadenceSeconds": 60,
  "messageJson": {
    "text": "continue this thread",
    "reason": "scheduled heartbeat"
  },
  "nextTickAt": "2026-05-22T21:00:00.000Z"
}
```

The next implementation step is script-first: add a goal-inference script that
reads ordered messages and updates `threads.goal_json`, then add a repo-start
smoke that clones the agent repo, materializes thread context, runs
`threadbeat-agent.mjs` or `threadbeat-agent.sh`, streams thread events, and
appends an agent checkpoint message.

## CLI

The CLI is a smoke driver, not a full operator UI.

```bash
npm run cli -- thread create thread.json
npm run cli -- thread list
npm run cli -- thread get <thread_id>
npm run cli -- message append <thread_id> message.json
npm run cli -- worker drain-once
npm run cli -- events follow --thread <thread_id>
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
npm run smoke:threads
npm run smoke:goal
npm run smoke:events
npm run smoke:repo-start
```

Live Daytona checks:

```bash
npm run smoke:daytona
npm run smoke:pi-daytona
```

`smoke:repo-start` is intentionally evidence-first: it starts the real research
agent repo from materialized thread messages in Daytona and passes if Threadbeat
records either successful run artifacts or truthful failure evidence on the
thread. Current Daytona generic HTTPS egress can fail inside Node/curl, so the
failure path is part of the smoke rather than hidden by a fake success.

## Current Daytona Note

The Daytona adapter creates sandboxes from a small image with zsh, bash, git,
node, and npm installed, then executes commands through short-lived Daytona shell
sessions. Keep Daytona execution details inside `src/sandbox/daytona.ts` unless
another runtime path is proven necessary by `npm run smoke:daytona`.
