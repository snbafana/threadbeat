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

By default the server dry-runs Modal until Modal credentials are present. To use
live Modal Sandboxes, put only the required secrets in `.env`:

```bash
MODAL_TOKEN_ID=...
MODAL_TOKEN_SECRET=...
DEEPSEEK_API_KEY=...
```

Modal's JavaScript SDK is installed as `modal` and expects Node 22+.
The base sandbox image, Modal app name, Pi image layers, timeout values, GitHub
owner default, and sandbox Pi provider/model live in `src/config.ts`.
Agent sandboxes receive only `DEEPSEEK_API_KEY`; the rest of the server
environment is not copied into agent compute.

`runs boot` writes the Threadbeat objective to `tasks/inbox/<run>.md`, reads
the repo-local `.pi/prompts/heartbeat.md`, and pipes both into Pi with
`pi --mode json -p`. That is the documented noninteractive Pi path; autonomous
agent runs still require `DEEPSEEK_API_KEY` in `.env`.

`runs boot` uses the longer agent boot timeout; ordinary `runs exec`,
`sandboxes exec`, runtime checks, and finalize commands use the sandbox exec
timeout. CLI exec calls can override with `--timeout-ms`.

To check live-run readiness without printing secrets:

```bash
npm run cli -- preflight
```

The preflight endpoint reports whether Modal credentials, hosted Git settings,
sandbox Pi auth, Pi image setup, and timeout settings are present. It
returns readiness check rows without printing secret values.

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
the same Pi image layers used by the server defaults, runs `command -v pi &&
pi --help`, and terminates the sandbox.

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
npm run smoke:modal-agent-real-task
```

This smoke can consume model-provider credits. It requires Modal credentials,
`DEEPSEEK_API_KEY`, and a `gh auth token` with `delete_repo`. It creates a
hosted Git-backed agent repo, bootstraps it into Modal with the real Pi image,
runs `runs boot`, checks that the worktree changed, finalizes the run branch,
and deletes the temporary GitHub repo.

Hosted Git uses GitHub. The default owner and owner-type detection live in
`src/config.ts`; live private repo creation uses `gh auth token` from the local
GitHub CLI session.

GitHub live creation is guarded before the network call. The initial policy is
conservative: one create per owner per 10 seconds and six creates per owner per
minute.

To verify live GitHub credentials without printing secrets:

```bash
npm run smoke:github
npm run smoke:github-init-cli
```

The smokes create real private GitHub repos when credentials are present,
validate the remote URL or CLI template init, and delete the repos. The token
must include `delete_repo`; without a `gh auth token`, the smokes exit
successfully with a skip message.

## CLI

```bash
npm run cli -- health
npm run cli -- agents template --name research --out ./agents/research
npm run cli -- agents init --name research --repo-id research-agent
npm run cli -- agents init --name research --repo-id research-agent --dry-run
npm run cli -- agents create --name research --repo https://github.com/org/repo.git --branch main
npm run cli -- agents list
npm run cli -- agents repo <agent>
npm run cli -- runs plan --agent <agent> --objective "one bounded task"
npm run cli -- runs queue --agents <agent>,<agent> --objectives-file ./tasks.txt
npm run cli -- runs work --agent <agent> --until-empty --bootstrap --check-runtime --recover --worker-id worker-a
npm run cli -- runs list --agent <agent>
npm run cli -- runs status <run>
npm run cli -- runs claim <run> --worker-id worker-a
npm run cli -- runs requeue <run> --worker-id worker-a
npm run cli -- runs watch <run>
npm run cli -- runs backlog --agents <agent>,<agent>
npm run cli -- runs stop-matching --agents <agent>,<agent> --status planned
npm run cli -- runs monitor --agents <agent>,<agent> --status planned,running
npm run cli -- runs step --agent <agent> --objective "one bounded task" --bootstrap --finalize -- "pwd"
npm run cli -- runs sandbox <run> [--bootstrap]
npm run cli -- runs restart-sandbox <run> [--bootstrap]
npm run cli -- runs exec <run> -- "pwd"
npm run cli -- runs finalize <run> --message "Finalize run"
npm run cli -- runs stop <run>
npm run cli -- agents hosted-git <agent>
npm run cli -- hosted-git list
npm run cli -- heartbeats list --agent <agent>
npm run cli -- heartbeats get <heartbeat>
npm run cli -- sandboxes start --agent <agent>
npm run cli -- sandboxes list --agent <agent>
npm run cli -- sandboxes get <sandbox>
npm run cli -- sandboxes exec <sandbox> -- "pwd && ls -la"
npm run cli -- sandboxes stop-running --agent <agent>
npm run cli -- sandboxes bootstrap <sandbox>
npm run cli -- sandboxes stop <sandbox>
npm run cli -- messages list --sandbox <sandbox>
npm run cli -- messages listen --sandbox <sandbox>
```

Agent template generation is Pi-native but does not run Pi:

- `POST /api/agent-template` returns a file manifest for a git-backed agent repo.
- `agents template --name <name> --out <dir>` materializes `AGENTS.md`, `.pi/prompts`, `.pi/skills`, `.pi/extensions`, `state/`, `tasks/`, `findings/`, `artifacts/`, and `.gitignore`.
- `POST /api/agents/from-template` and `agents init` create a hosted Git repo record from the template; when hosted Git credentials are present, Threadbeat writes an initial Git commit and pushes it to the hosted remote. Use `--dry-run` to force planning without a cloud call.
- Server-side Pi and sandbox-agent Pi remain separate; this only creates the sandbox-agent repo shape.

Run planning is intentionally server-side and Pi-free for now:

- `POST /api/agents/:id/runs` creates a persisted run plan and Git branch name.
- `GET /api/agents/:id/runs` lists planned/completed runs for an agent.
- `GET /api/runs/:id` reads one run record.
- `GET /api/runs/:id/status` reads one run with sandboxes and messages.
- `POST /api/runs/:id/claim` atomically moves a run from `planned` to
  `running`. Workers use this before starting a sandbox so competing workers do
  not process the same planned run.
- `runs queue --objectives-file <file>` creates planned runs from a newline
  separated task file for one or more agents. Blank lines and `#` comments are
  ignored; workers can then drain the backlog with `runs work --loop --recover`.
- `POST /api/runs/:id/requeue` moves an unfinished run with no running sandbox
  back to `planned`, which lets an operator recover a worker that claimed a run
  and exited before starting the sandbox.
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

The `runs launch`, `runs work`, and `runs step` CLI commands are client-side
orchestration over the existing run APIs. `runs launch` creates and starts
multiple runs immediately. `runs work` drains already planned runs for one or
more agents. Use `--until-empty` to keep claiming batches until the queue is
idle, or `--loop` to poll for longer CLI worker sessions. Add `--recover` to
requeue unfinished running runs that no longer have a running sandbox before
the worker claims new work. Add `--worker-id` so claim and requeue lifecycle
messages show which CLI worker touched a run; claimed runs also expose
`worker_id` in run status/list/monitor responses.
`runs watch` polls one run's status and messages until it completes, fails, or
stops. `runs backlog` reports run counts by status for one or more agents.
`runs stop-matching --status planned` cancels queued runs for one or more
agents; include `running` in the status list to stop active run sandboxes too.
`runs monitor` snapshots all runs for one or more agents, including
sandbox states and recent message types/text. Use `--status planned,running` to
focus the snapshot on queued or active work. `runs step` executes one explicit
shell command and can optionally finalize the run branch.

## Phases

See [docs/modal-control-plane-plan.md](docs/modal-control-plane-plan.md).
