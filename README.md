# threadbeat

`threadbeat` is being rewritten as a clean control plane for Git-backed agents
that execute inside disposable sandboxes.

The current root implementation is intentionally small:

- Fastify API
- libSQL/SQLite persistence
- Git-backed agent registry
- heartbeat rows for future wakeup policy
- message log for streaming state
- Modal sandbox start/exec/stop provider
- CLI for calling the API

The old hosted Pi heartbeat prototype is preserved under
`archive/2026-05-08-pre-modal-rewrite/`.

## Local Run

```bash
npm install
cp .env.example .env
npm run dev
```

By default Modal is in dry-run mode. To use live Modal Sandboxes:

```bash
THREADBEAT_MODAL_MODE=live
MODAL_TOKEN_ID=...
MODAL_TOKEN_SECRET=...
```

Modal's JavaScript SDK is installed as `modal` and expects Node 22+.

## CLI

```bash
npm run cli -- health
npm run cli -- agents create --name research --repo https://github.com/org/repo.git --branch main
npm run cli -- agents list
npm run cli -- heartbeats list --agent <agent_id>
npm run cli -- heartbeats get <heartbeat_id>
npm run cli -- sandboxes start --agent <agent_id>
npm run cli -- sandboxes list --agent <agent_id>
npm run cli -- sandboxes get <sandbox_id>
npm run cli -- sandboxes exec <sandbox_id> -- "pwd && ls -la"
npm run cli -- sandboxes bootstrap <sandbox_id>
npm run cli -- sandboxes stop <sandbox_id>
npm run cli -- messages list --sandbox <sandbox_id>
npm run cli -- messages listen --sandbox <sandbox_id>
```

`sandboxes bootstrap` calls `POST /api/sandboxes/:id/bootstrap`. The route uses
the sandbox service bootstrap implementation when present, and otherwise returns
a clear `501` without requiring database changes.

Read-only API inspection routes:

- `GET /api/heartbeats?agentId=<agent_id>`
- `GET /api/heartbeats/:id`
- `GET /api/sandboxes?agentId=<agent_id>`
- `GET /api/sandboxes/:id`
- `GET /api/messages?agentId=<agent_id>&sandboxId=<sandbox_id>&limit=50`
- `GET /api/messages/listen?agentId=<agent_id>&sandboxId=<sandbox_id>`

Snake-case query aliases such as `agent_id` and `sandbox_id` are accepted for
inspection routes.

## Phases

See [docs/modal-control-plane-plan.md](docs/modal-control-plane-plan.md).
