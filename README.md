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

To run the full local control-plane validation path in order:

```bash
npm run smoke:control-plane-live
```

This runs the GitHub hosted-agent CLI init smoke, the Modal server/CLI sandbox
smoke, and the Modal Git-backed agent bootstrap smoke with the real Pi runtime.
It does not run an autonomous model task by default.

To include the credit-consuming autonomous Pi task and verify a pushed result
commit on the run branch:

```bash
npm run smoke:control-plane-real-task
```

To run the server locally for manual control-plane work:

```bash
npm run dev
npm run cli -- preflight
npm run cli -- agents init --name research --repo-id research-agent --live
```

Then use the `runs queue`, `runs work`, `runs monitor`, `runs branches`, and
`runs checkout` commands below against the live server.

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
npm run cli -- runs queue --agents <agent>,<agent> --objective "one bounded task"
npm run cli -- runs queue --agents <agent>,<agent> --objectives-file ./tasks.txt
npm run cli -- runs queue --agents <agent>,<agent> --objectives-file ./tasks.txt --assignment round-robin
npm run cli -- runs queue --agents <agent>,<agent> --objectives-file ./tasks.txt --assignment round-robin --dry-run
npm run cli -- runs work --agent <agent> --until-empty --bootstrap --check-runtime --recover --worker-id worker-a
npm run cli -- runs work --agents <agent>,<agent> --resume-stopped --boot --until-empty
npm run cli -- runs work --agents <agent>,<agent> --workers 3 --worker-prefix worker --until-empty
npm run cli -- runs work --agents <agent>,<agent> --workers 3 --worker-prefix worker --detach --session overnight --loop --recover
npm run cli -- runs list --agent <agent> [--status planned,running,completed,stopped,failed]
npm run cli -- runs status <run>
npm run cli -- runs inspect <run>
npm run cli -- runs inspect <run> --checkout --checkout-dir ./checkouts/<run>
npm run cli -- runs checkout <run> --dir ./checkouts/<run>
npm run cli -- runs review <run> --checkout-dir ./checkouts/<run>
npm run cli -- runs checkout-session overnight --dir ./checkouts/overnight
npm run cli -- runs checkout-session overnight --dir ./checkouts/overnight-resume --resumable --worker-id worker-a
npm run cli -- runs claim <run> --worker-id worker-a
npm run cli -- runs requeue <run> --worker-id worker-a
npm run cli -- runs resume-branch <stopped-run> --worker-id worker-a
npm run cli -- runs recover --agents <agent>,<agent> --include-stopped --dry-run
npm run cli -- runs recover --agents <agent>,<agent> --include-stopped --worker-id worker-a
npm run cli -- runs watch <run>
npm run cli -- runs backlog --agents <agent>,<agent>
npm run cli -- runs branches --agents <agent>,<agent>
npm run cli -- runs branches --session overnight
npm run cli -- runs branches --session overnight --resumable
npm run cli -- runs branches --agents <agent>,<agent> --worker-id worker-a
npm run cli -- runs results --session overnight
npm run cli -- runs results --session overnight --worker-id worker-a
npm run cli -- runs results --session overnight --checkout-dir ./checkouts/overnight-results
npm run cli -- runs results --session overnight --checkout-dir ./checkouts/overnight-results --changed-only
npm run cli -- runs results --session overnight --checkout-dir ./checkouts/overnight-results --changed-path report.md
npm run cli -- runs results --session overnight --max-polls 30 --interval-ms 10000
npm run cli -- runs workers --agents <agent>,<agent>
npm run cli -- runs sessions
npm run cli -- runs session-status overnight
npm run cli -- runs session-summary overnight
npm run cli -- runs session-review overnight --include-stopped --lines 40
npm run cli -- runs session-review overnight --include-stopped --next
npm run cli -- runs session-review overnight --include-stopped --checkout-dir ./checkouts/overnight-review
npm run cli -- runs session-watch overnight --max-polls 5
npm run cli -- runs session-logs overnight --lines 40
npm run cli -- runs recover-session overnight --dry-run
npm run cli -- runs resume-session overnight --worker-id worker-a --dry-run
npm run cli -- runs stop-session overnight --recover
npm run cli -- runs restart-session overnight --recover
npm run cli -- runs supervise --agents <agent>,<agent> --session overnight --workers 3 --recover --include-stopped
npm run cli -- runs dispatch --agents <agent>,<agent> --objective "one bounded task" --session overnight --workers 3 --boot --recover
npm run cli -- runs dispatch --agents <agent>,<agent> --objectives-file ./tasks.txt --session overnight --workers 3 --boot --recover --include-stopped
npm run cli -- runs dispatch --agents <agent>,<agent> --objectives-file ./tasks.txt --assignment round-robin --session overnight --workers 3 --boot --recover
npm run cli -- runs dispatch --agents <agent>,<agent> --objectives-file ./tasks.txt --assignment round-robin --session overnight --workers 3 --dry-run
npm run cli -- runs stop-matching --agents <agent>,<agent> --status planned
npm run cli -- runs monitor --agents <agent>,<agent> --status planned,running
npm run cli -- runs step --agent <agent> --objective "one bounded task" --bootstrap --finalize -- "pwd"
npm run cli -- runs sandbox <run> [--bootstrap]
npm run cli -- runs restart-sandbox <run> [--bootstrap]
npm run cli -- runs resume <run> [--no-bootstrap] [--check-runtime] [--boot]
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
- `GET /api/agents/:id/runs` lists runs for an agent. Add `?status=planned,running`
  to fetch only the states needed for monitors or long worker sessions.
- `GET /api/runs/:id` reads one run record.
- `GET /api/runs/:id/status` reads one run with sandboxes and messages.
- `runs inspect <run>` combines run state, branch/base refs, result commit,
  GitHub links, sandbox states, recent messages, and concrete checkout/watch
  commands for branch-native review. Add `--checkout --checkout-dir <path>` to
  clone or refresh the run branch and include changed files/commits in the same
  payload.
- `runs checkout <run> --dir <path>` clones or refreshes the run branch into a
  local Git checkout and reports base/head commits, commits ahead, and changed
  files so the branch state can be reviewed directly.
- `runs review <run> --checkout-dir <path>` is the compact single-run review
  path: it checks out the run branch and returns changed files, commits, and the
  exact `git diff`/`git log` commands for that branch.
- `runs checkout-session <name> --dir <path>` checks out every completed or
  stopped branch run from a detached worker session under `<path>/<run-id>`.
  Add `--resumable` to pull only stopped branches without result commits, or
  `--worker-id <id>` to pull only branches claimed by one worker.
- `runs branches --session <name>` adds an ownership `location` to each listed
  branch run so an operator can see whether it is unassigned, owned by that
  session, or claimed by another worker.
- `runs results --session <name>` reports completed and stopped branch runs for
  a worker session with GitHub branch/result links and warnings for completed
  runs that do not have a recorded result commit. Session results include
  whether each visible run is still unassigned, claimed by a session worker, or
  claimed by another worker. Add `--checkout-dir <path>` to clone or refresh
  each listed run branch under `<path>/<run-id>` and include changed
  files/commits in the result payload. Add `--changed-only` with `--checkout-dir`
  to show only branches whose checkout has changed files, commits, or a review
  error, or `--changed-path <path[,path]>` to show only runs that changed
  specific paths. Result rows also include a
  `commands.checkoutBranch` command for local branch inspection. Add
  `--max-polls` and `--interval-ms` to keep emitting result snapshots while a
  long session runs.
- `POST /api/runs/:id/claim` atomically moves a run from `planned` to
  `running`. Workers use this before starting a sandbox so competing workers do
  not process the same planned run.
- `runs queue --objective "task"` creates planned runs from an inline task for
  one or more agents. Use `--objectives-file <file>` for a newline separated
  task file. Blank lines and `#` comments are ignored; workers can then drain
  the backlog with `runs work --loop --recover`. The default assignment is
  `fanout`, which gives every listed agent every objective. Use
  `--assignment round-robin` to split the tasks across agents. Add `--dry-run`
  to preview the assignment without creating run branches.
- `runs dispatch --objective "task" --session <name>` queues an inline task
  across agents and starts a detached worker session in one command, leaving
  branch state visible through `runs monitor`, `runs branches`, and
  `runs checkout`. Use `--objectives-file` for a file-backed batch. It uses the
  same `--assignment fanout|round-robin` behavior as `runs queue`; add
  `--dry-run` to preview assigned objectives and the worker command without
  creating runs or starting workers.
- `POST /api/runs/:id/requeue` moves an unfinished run with no running sandbox
  back to `planned`, which lets an operator recover a worker that claimed a run
  and exited before starting the sandbox.
- `POST /api/runs/:id/sandbox` starts a sandbox on that run branch and tags
  sandbox/messages with the run id. Pass `{ "bootstrap": true }` to clone and
  checkout the repo immediately after the sandbox starts. Repeated calls return
  the existing running sandbox.
- `POST /api/runs/:id/restart-sandbox` starts a fresh sandbox for a stopped or
  failed run sandbox while preserving the old sandbox record.
- `runs resume <run>` is the operator path for continuing an unfinished branch:
  it reuses a running sandbox, restarts a stopped/failed sandbox, or starts a
  first sandbox, bootstrapping the run branch by default.
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
multiple runs immediately. `runs recover` requeues `running` runs that no longer
have a running sandbox, so an operator can make orphaned claims available before
starting workers again. Recovery output includes objective, branch name, result
commit, and worker claim state. Add `--dry-run` to preview recoverable runs
without changing their state. Add `--include-stopped` to also requeue stopped
branch runs that have no result commit before restarting a worker fleet. `runs supervise`
snapshots backlog, optionally recovers orphaned claims or stopped unfinished
branches with `--recover --include-stopped`, and starts a named detached worker
session for one or more agents. `runs dispatch` uses the same recovery flags
after queueing its objective file and before starting workers. `runs work` drains
already planned runs for one or more agents. Use `--until-empty` to keep
claiming batches until the queue is idle, or `--loop` to poll for longer CLI
worker sessions. Add `--recover` to
requeue unfinished running runs that no longer have a running sandbox before
the worker claims new work. Add `--resume-stopped` to include stopped unfinished
runs in the worker queue; those branches are bootstrapped by default unless
`--no-bootstrap` is also passed. A worker only resumes stopped branches that are
unassigned or already claimed by that worker id; use `--recover --include-stopped`
when an operator needs to reclaim stopped branches first. Add `--worker-id` so
claim and requeue lifecycle messages show which CLI worker touched a run;
claimed runs also expose `worker_id` in run status/list/monitor responses. Add
`--finalize` to have processed items include the run branch and result commit
directly in the worker output. Add `--workers <n>` to start multiple foreground
worker subprocesses with `--worker-prefix` IDs. Add
`--detach --session <name>` to leave that worker group running after the parent
CLI exits; Threadbeat records worker PIDs and stdout/stderr log paths under
`.threadbeat/worker-sessions/`. Use `runs sessions` to inspect local worker
sessions, `runs session-status <name>` to see worker liveness plus matching
queued/claimed run branches, `runs session-watch <name>` to stream those snapshots
while the session runs, `runs session-logs <name>` to read recent worker
stdout/stderr, and `runs stop-session <name>` to terminate the recorded process
group. Add `--recover` to `runs stop-session` to requeue unfinished runs claimed
by that session's workers when those runs do not have a running sandbox.
Add `--recoverable` to `runs session-status` or `runs session-watch` to include
a dry-run recovery preview in the live session snapshot; combine it with
`--include-stopped` to surface unfinished stopped branches too.
`runs session-summary <name>` rolls up worker liveness, run statuses, completed
result commits, and resumable stopped branches for that session's agents.
`runs session-review <name> --include-stopped` is the read-only operator summary
for a long-running session: worker liveness, agent run status, completed result
branches with checkout/inspect commands, resumable branch list with concrete
checkout/resume commands, dry-run recovery candidates, ordered `nextSteps`, and
recent worker logs in one payload. Add `--next` to return only the compact
summary and ordered next-step commands. The full snapshot also includes an
`actions` block with the exact restart, recover, resume, and changed-results
commands to run next. Add
`--checkout-dir <path>` to include local checkouts for completed/stopped run
branches plus a top-level `changedResults` list in the same snapshot. Add
`--changed-only` or `--changed-path <path[,path]>` with `--checkout-dir` to
make the review snapshot show only branches with local changes that matter.
`runs recover-session <name>` requeues stale runs claimed by that session's
workers without stopping or restarting the worker group; add `--dry-run` to
preview the affected runs first. Add `--include-stopped` to also requeue
unfinished stopped branch runs for that session's agents.
`runs resume-session <name>` is the branch-only bulk resume path for a detached
worker session: it requeues stopped runs with no result commit while leaving
completed result branches alone. Add `--worker-id <id>` to target only that
worker's claimed stopped branches, or `--dry-run` to preview the requeue first.
`runs results --session <name>` shows the branch-native output surface for those
runs without creating PRs: branch compare/tree links, result commit links when
available, missing-result warnings, top-level result/resumable/changed counts,
and a `changedFiles` index when local checkouts are requested with
`--checkout-dir`. Add `--worker-id <id>` to review only branches claimed by one
worker.
`runs restart-session <name> --recover` respawns dead workers from the recorded
session command and requeues stale claimed runs before the replacements start.
Add `--resume-stopped` when the restarted workers should continue stopped branch
runs from the same session; this updates the recorded worker command for later
session inspection and restarts.
`runs watch` polls one run's status and messages until it completes, fails, or
stops. `runs backlog` reports run counts by status for one or more agents and
includes `resumableStopped` for stopped branch runs that `--resume-stopped` can
pick up. `runs branches` lists completed and stopped branch runs across agents,
including base refs, branch names, result commits, and resumable stopped runs;
pass `--session <name>` to inspect the branch state for a detached worker group,
add `--worker-id <id>` to focus on one worker's claimed branches, or add
`--resumable` to show only stopped branches without a result commit.
Use `runs resume-branch <run>` to requeue one of those stopped branch runs back to
`planned` without touching the rest of the session.
`runs workers` groups running runs by the `worker_id` that claimed them.
`runs stop-matching --status planned` cancels queued runs for one or more
agents; include `running` in the status list to stop active run sandboxes too.
`runs monitor` snapshots all runs for one or more agents, including
sandbox states, recent message types/text, and a `resumable` marker on stopped
branch runs. Use `--status planned,running,stopped` to focus the snapshot on
queued, active, or resumable work. `runs step` executes one explicit shell
command and can optionally finalize the run branch.

## Phases

See [docs/modal-control-plane-plan.md](docs/modal-control-plane-plan.md).
