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
`THREADBEAT_MODAL_IMAGE` is the base sandbox image. Set
`THREADBEAT_MODAL_INSTALL_SANDBOX_PI=1` to layer the Pi CLI into the Modal
sandbox image with `npm install -g @mariozechner/pi-coding-agent`. Add
newline-separated Dockerfile layers through `THREADBEAT_MODAL_IMAGE_COMMANDS`
for any extra sandbox-only tools. The server does not embed Pi for agent runs;
`THREADBEAT_AGENT_PI_COMMAND` is executed inside the sandbox workdir by
`runs boot`. Sandbox Pi defaults to the archived DeepSeek setup:

```bash
THREADBEAT_AGENT_PI_PROVIDER=deepseek
THREADBEAT_AGENT_PI_MODEL=deepseek-v4-flash
THREADBEAT_AGENT_PI_API_KEY_ENV=DEEPSEEK_API_KEY
```

`runs boot` writes the Threadbeat objective to `tasks/inbox/<run_id>.md`, reads
the repo-local `.pi/prompts/heartbeat.md`, and pipes both into Pi with
`pi --mode json -p`. That is the documented noninteractive Pi path; autonomous
agent runs still require sandbox-side provider auth such as API-key environment
variables or a Pi auth file.

To pass model-provider credentials into agent sandboxes, opt in by name:

```bash
THREADBEAT_SANDBOX_ENV_ALLOWLIST=DEEPSEEK_API_KEY
DEEPSEEK_API_KEY=...
```

Only listed variables that are present in the server environment are injected
into Modal sandboxes. This is intentionally separate from server-side Pi and
avoids copying the whole server environment into agent compute.

Sandbox commands have bounded execution by default:

```bash
THREADBEAT_SANDBOX_EXEC_TIMEOUT_MS=120000
THREADBEAT_AGENT_BOOT_TIMEOUT_MS=600000
```

`runs boot` uses the longer agent boot timeout; ordinary `runs exec`,
`sandboxes exec`, runtime checks, and finalize commands use the sandbox exec
timeout. CLI exec calls can override with `--timeout-ms`.

To check live-run readiness without printing secrets:

```bash
npm run cli -- preflight
```

The preflight endpoint reports whether Modal credentials, hosted Git settings,
sandbox auth allowlisting, Pi image setup, and timeout settings are present. It
only returns booleans and environment variable names.

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

To verify that the sandbox image can install the real Pi CLI:

```bash
npm run smoke:modal-pi-image
```

This smoke starts a real Modal sandbox with
`THREADBEAT_MODAL_INSTALL_SANDBOX_PI` equivalent image layers, runs
`command -v pi && pi --help`, and terminates the sandbox. It only verifies the
sandbox Pi binary; it does not load server-side Pi.

To verify the sandbox-agent boot path against a real Modal sandbox:

```bash
npm run smoke:modal-agent-boot
```

This smoke layers a tiny test `pi` binary into the Modal image, bootstraps a run
workdir, calls `runs boot`, and verifies that the Pi command is invoked from the
sandbox. It proves the boot plumbing without mixing server Pi with sandbox-agent
Pi.

To verify the same Git-backed agent bootstrap path with the real Pi image layer:

```bash
npm run smoke:modal-agent-real-pi-runtime
```

This smoke creates a hosted Git-backed agent, starts and bootstraps a Modal run
sandbox, verifies `AGENTS.md` and `.pi/*` from the cloned repo, and runs
`command -v pi && pi --help` from the sandbox workdir. It intentionally stops
before an autonomous Pi task so model/provider auth remains separate from
runtime validation.

To run the first real authenticated Pi task in a Modal sandbox:

```bash
THREADBEAT_RUN_REAL_PI_TASK=1 \
THREADBEAT_SANDBOX_ENV_ALLOWLIST=DEEPSEEK_API_KEY \
npm run smoke:modal-agent-real-task
```

This smoke is opt-in because it can consume model-provider credits. It creates a
hosted Git-backed agent repo, bootstraps it into Modal with the real Pi image,
runs `runs boot`, checks that the worktree changed, finalizes the run branch,
and deletes the temporary GitHub repo by default.

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
