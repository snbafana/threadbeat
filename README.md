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

To verify live Modal credentials:

```bash
npm run smoke:modal
```

The smoke starts a real Modal sandbox, runs `python --version`, and terminates
the sandbox. Without Modal credentials it exits successfully with a skip message.

To verify the server and CLI control plane against a real Modal sandbox:

```bash
npm run smoke:modal-cli
```

This starts the server in live Modal mode, drives it through `threadbeat-cli`,
executes `python --version`, and cleans up with `sandboxes stop-running`.

Hosted Git is behind a provider boundary:

```bash
THREADBEAT_GIT_PROVIDER=code-storage
# or
THREADBEAT_GIT_PROVIDER=github
THREADBEAT_GITHUB_OWNER=your-org
THREADBEAT_GITHUB_OWNER_TYPE=org
THREADBEAT_GITHUB_TOKEN=...
```

`github` supports dry-run repository planning and live private repo creation
when `THREADBEAT_GITHUB_TOKEN` is present. `THREADBEAT_GITHUB_OWNER_TYPE=user`
switches creation from `/orgs/:owner/repos` to `/user/repos`.

GitHub live creation is guarded before the network call. The initial policy is
conservative: one create per owner per 10 seconds and six creates per owner per
minute.

To verify live GitHub credentials without printing secrets:

```bash
npm run smoke:github
npm run smoke:github-init
npm run smoke:github-init-cli
```

The smokes create real private GitHub repos when credentials are present,
validate the remote URL, API template init, or CLI template init, and delete the repos by default. The token must include
`delete_repo` unless `THREADBEAT_GITHUB_LIVE_SMOKE_KEEP=1` is set to
intentionally leave smoke repos behind for manual inspection. Without
credentials it exits successfully with a skip message.

`THREADBEAT_GITHUB_OWNER_TYPE=auto` detects personal-account repos by comparing
`THREADBEAT_GITHUB_OWNER` with the authenticated GitHub login. Use `user` or
`org` only when you want to force a specific creation endpoint.

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
npm run cli -- agents template --name research --out ./agents/research
npm run cli -- agents init --name research --repo-id research-agent
npm run cli -- agents init --name research --repo-id research-agent --dry-run
npm run cli -- agents create --name research --repo https://github.com/org/repo.git --branch main
npm run cli -- agents list
npm run cli -- agents repo <agent_id>
npm run cli -- runs plan --agent <agent_id> --objective "one bounded task"
npm run cli -- runs list --agent <agent_id>
npm run cli -- runs status <run_id>
npm run cli -- runs step --agent <agent_id> --objective "one bounded task" --bootstrap --finalize -- "pwd"
npm run cli -- runs sandbox <run_id> [--bootstrap]
npm run cli -- runs restart-sandbox <run_id> [--bootstrap]
npm run cli -- runs exec <run_id> -- "pwd"
npm run cli -- runs finalize <run_id> --message "Finalize run"
npm run cli -- runs stop <run_id>
npm run cli -- code-storage create --agent <agent_id> --id <repo_id>
npm run cli -- code-storage list
npm run cli -- heartbeats list --agent <agent_id>
npm run cli -- heartbeats get <heartbeat_id>
npm run cli -- sandboxes start --agent <agent_id>
npm run cli -- sandboxes list --agent <agent_id>
npm run cli -- sandboxes get <sandbox_id>
npm run cli -- sandboxes exec <sandbox_id> -- "pwd && ls -la"
npm run cli -- sandboxes stop-running --agent <agent_id>
npm run cli -- sandboxes bootstrap <sandbox_id>
npm run cli -- sandboxes stop <sandbox_id>
npm run cli -- messages list --sandbox <sandbox_id>
npm run cli -- messages listen --sandbox <sandbox_id>
```

`sandboxes bootstrap` calls `POST /api/sandboxes/:id/bootstrap`. The route uses
the sandbox service bootstrap implementation when present, and otherwise returns
a clear `501` without requiring database changes.

Agent template generation is Pi-native but does not run Pi:

- `POST /api/agent-template` returns a file manifest for a git-backed agent repo.
- `agents template --name <name> --out <dir>` materializes `AGENTS.md`, `.pi/prompts`, `.pi/skills`, `.pi/extensions`, `state/`, `tasks/`, `findings/`, `artifacts/`, and `.gitignore`.
- `POST /api/agents/from-template` and `agents init` create a hosted Git repo record from the template; when hosted Git credentials are present, Threadbeat writes an initial Git commit and pushes it to the hosted remote. Use `--dry-run` to force planning without a cloud call.
- Server-side Pi and sandbox-agent Pi remain separate; this only creates the sandbox-agent repo shape.

Run planning is intentionally server-side and Pi-free for now:

- `POST /api/agents/:id/runs` creates a persisted run plan and Git branch name.
- `GET /api/agents/:id/runs` lists planned/completed runs for an agent.
- `GET /api/runs/:id` reads one run with compare/tree links.
- `GET /api/runs/:id/status` reads one run with its branch plan, sandboxes, and
  latest messages.
- `POST /api/runs/:id/sandbox` starts a sandbox on that run branch and tags
  sandbox/messages with the run id. Pass `{ "bootstrap": true }` to clone and
  checkout the repo immediately after the sandbox starts. Repeated calls return
  the existing running sandbox.
- `POST /api/runs/:id/restart-sandbox` starts a fresh sandbox for a stopped or
  failed run sandbox while preserving the old sandbox record.
- `POST /api/runs/:id/exec` runs a bounded command in the run sandbox, defaulting
  to the bootstrapped repo workdir.
- `POST /api/runs/:id/finalize` commits sandbox worktree changes, pushes the run
  branch, and records the result commit on the run.
- `POST /api/runs/:id/stop` stops the run sandbox when one exists and marks the
  run `stopped`.
- `POST /api/sandboxes/stop-running` stops all running sandboxes matching an
  `agentId` or `runId` filter. At least one filter is required.

The `runs step` CLI command is client-side orchestration over the existing run
APIs. It can plan a run, start/bootstrap its sandbox, execute one command, and
optionally finalize the run branch without introducing a new server primitive.

Read-only API inspection routes:

- `GET /api/agents/:id/runs`
- `GET /api/runs/:id`
- `GET /api/runs/:id/status`
- `POST /api/runs/:id/sandbox`
- `POST /api/runs/:id/restart-sandbox`
- `POST /api/runs/:id/exec`
- `POST /api/runs/:id/finalize`
- `POST /api/runs/:id/stop`
- `POST /api/sandboxes/stop-running`
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
