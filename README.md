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

Hosted Git is behind a provider boundary:

```bash
THREADBEAT_GIT_PROVIDER=code-storage
# or
THREADBEAT_GIT_PROVIDER=github
THREADBEAT_GITHUB_OWNER=your-org
THREADBEAT_GITHUB_TOKEN=...
```

`github` currently supports dry-run repository planning only; live creation is
kept disabled until the GitHub App/PAT flow and rate-limit handling are explicit.
The point of the boundary is to add live GitHub, Gitea, or GitLab without
changing run planning or sandbox startup.

GitHub live creation is guarded before the network call. The initial policy is
conservative: one create per owner per 10 seconds and six creates per owner per
minute.

To use live Code.Storage repo creation, set:

```bash
CODE_STORAGE_NAME=your-org
CODE_STORAGE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----..."
```

Without a private key, Code.Storage creation endpoints run in explicit dry-run
mode and store only a redacted remote URL.

To verify live Code.Storage credentials without printing secrets:

```bash
npm run smoke:code-storage
```

The smoke creates a real Code.Storage repo from `octocat/Hello-World` when
credentials are present, validates the remote URL, and deletes the repo by
default. Set `CODE_STORAGE_LIVE_SMOKE_KEEP=1` to leave the smoke repo behind for
manual inspection. Without credentials it exits successfully with a skip
message.

## CLI

```bash
npm run cli -- health
npm run cli -- agents create --name research --repo https://github.com/org/repo.git --branch main
npm run cli -- agents list
npm run cli -- agents repo <agent_id>
npm run cli -- runs plan --agent <agent_id> --objective "one bounded task"
npm run cli -- runs list --agent <agent_id>
npm run cli -- runs sandbox <run_id>
npm run cli -- code-storage create --agent <agent_id> --id <repo_id>
npm run cli -- code-storage list
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

Run planning is intentionally server-side and Pi-free for now:

- `POST /api/agents/:id/runs` creates a persisted run plan and Git branch name.
- `GET /api/agents/:id/runs` lists planned/completed runs for an agent.
- `GET /api/runs/:id` reads one run with compare/tree links.
- `POST /api/runs/:id/sandbox` starts a sandbox on that run branch and tags
  sandbox/messages with the run id.

Read-only API inspection routes:

- `GET /api/agents/:id/runs`
- `GET /api/runs/:id`
- `POST /api/runs/:id/sandbox`
- `GET /api/heartbeats?agentId=<agent_id>`
- `GET /api/heartbeats/:id`
- `POST /api/agents/:id/code-storage`
- `GET /api/agents/:id/code-storage`
- `GET /api/code-storage/repos`
- `GET /api/sandboxes?agentId=<agent_id>&runId=<run_id>`
- `GET /api/sandboxes/:id`
- `GET /api/messages?agentId=<agent_id>&runId=<run_id>&sandboxId=<sandbox_id>&limit=50`
- `GET /api/messages/listen?agentId=<agent_id>&runId=<run_id>&sandboxId=<sandbox_id>`

Snake-case query aliases such as `agent_id`, `run_id`, and `sandbox_id` are accepted for
inspection routes.

## Phases

See [docs/modal-control-plane-plan.md](docs/modal-control-plane-plan.md).
