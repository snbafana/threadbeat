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

Then use `runs dispatch`, the returned worker/watch commands, `runs monitor`,
`runs branches`, and `runs checkout` below against the live server.

For the focused detached-worker control-plane smoke:

```bash
npm run smoke:detached-session
```

For a focused local multi-agent dispatch smoke:

```bash
npm run smoke:multi-agent-dispatch
```

For a branch-native multi-agent local run:

```bash
npm run dev
npm run cli -- preflight
npm run cli -- agents init --name research-a --repo-id research-a --live
npm run cli -- agents init --name research-b --repo-id research-b --live
printf "write one research note\nwrite one implementation note\n" > tasks.txt
npm run cli -- runs dispatch --agents <research-a>,<research-b> --objectives-file ./tasks.txt --assignment round-robin --session overnight --workers 2 --boot --recover --include-stopped --dry-run
npm run cli -- runs dispatch --agents <research-a>,<research-b> --objectives-file ./tasks.txt --assignment round-robin --session overnight --workers 2 --boot --recover --include-stopped --until-empty --wait
npm run cli -- runs dispatch --agents <research-a>,<research-b> --objectives-file ./tasks.txt --assignment round-robin --session overnight --workers 2 --boot --recover --include-stopped
npm run cli -- runs supervise --agents <research-a>,<research-b> --session overnight --workers 2 --boot --recover --include-stopped --until-empty --wait
npm run cli -- runs session-watch overnight --recoverable --include-stopped --next --max-polls 30 --interval-ms 10000
npm run cli -- runs session-actions overnight
npm run cli -- runs session-review overnight --include-stopped --checkout-dir ./checkouts/overnight-review
npm run cli -- runs results --session overnight --checkout-dir ./checkouts/overnight-results --changed-only --next
npm run cli -- runs results --session overnight --server --next --commands-only
npm run cli -- runs checkout-session overnight --dir ./checkouts/overnight
npm run cli -- runs stop-session overnight --recover
```

Each run stays on its own durable Git branch. Use `session-review`,
`runs results`, or the returned `actions` block to inspect result commits,
changed files, resumable stopped branches, and recovery commands; no PR is
created unless a separate PR path is added later.

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
npm run cli -- runs inspect-result <run> --server
npm run cli -- runs inspect-result <run> --checkout-dir ./checkouts/<run>-result
npm run cli -- runs checkout <run> --dir ./checkouts/<run>
npm run cli -- runs review <run> --checkout-dir ./checkouts/<run>
npm run cli -- runs branches --session overnight --next
npm run cli -- runs checkout-session overnight --dir ./checkouts/overnight
npm run cli -- runs checkout-session overnight --dir ./checkouts/overnight-resume --resumable --worker-id worker-a
npm run cli -- runs claim <run> --worker-id worker-a
npm run cli -- runs requeue <run> --worker-id worker-a
npm run cli -- runs resume-branch <stopped-run> --inspect
npm run cli -- runs resume-branch <stopped-run> --worker-id worker-a
npm run cli -- runs recover --agents <agent>,<agent> --include-stopped --dry-run
npm run cli -- runs recover --agents <agent>,<agent> --include-stopped --worker-id worker-a
npm run cli -- runs watch <run>
npm run cli -- runs watch <run> --checkout-dir ./checkouts/<run>
npm run cli -- runs backlog --agents <agent>,<agent>
npm run cli -- runs branches --agents <agent>,<agent>
npm run cli -- runs branches --session overnight
npm run cli -- runs branches --session overnight --resumable
npm run cli -- runs branches --session overnight --next --commands-only --format shell
npm run cli -- runs branches --agents <agent>,<agent> --worker-id worker-a
npm run cli -- runs results --session overnight
npm run cli -- runs results --session overnight --worker-id worker-a
npm run cli -- runs results --session overnight --run <run-id> --next
npm run cli -- runs results --session overnight --checkout-dir ./checkouts/overnight-results
npm run cli -- runs results --session overnight --checkout-dir ./checkouts/overnight-results --changed-only
npm run cli -- runs results --session overnight --checkout-dir ./checkouts/overnight-results --changed-only --next
npm run cli -- runs results --session overnight --server --next --commands-only
npm run cli -- runs results --session overnight --server --branch-action review_branch --next --commands-only
npm run cli -- runs results --session overnight --server --run <run-id> --next
npm run cli -- runs results --session overnight --next --commands-only --format shell
npm run cli -- runs results --session overnight --next --limit 20
npm run cli -- runs results --session overnight --next --limit 20 --offset 20
npm run cli -- runs results --session overnight --checkout-dir ./checkouts/overnight-results --changed-path report.md
npm run cli -- runs results --session overnight --max-polls 30 --interval-ms 10000
npm run cli -- runs workers --agents <agent>,<agent>
npm run cli -- runs sessions
npm run cli -- runs sessions --summary --next --limit 10
npm run cli -- runs sessions --summary --next --limit 10 --offset 10
npm run cli -- runs sessions --summary --next --max-polls 30 --interval-ms 10000
npm run cli -- runs sessions --summary --next --needs-action
npm run cli -- runs sessions --summary --next --older-than-ms 120000 --commands-only --format shell
npm run cli -- runs archive-sessions --dry-run
npm run cli -- runs session-actions overnight
npm run cli -- runs session-wait overnight --max-polls 30 --interval-ms 10000
npm run cli -- runs session-wait overnight --recoverable --include-stopped --max-polls 1
npm run cli -- runs session-status overnight
npm run cli -- runs session-status overnight --recoverable --include-stopped --next --commands-only --format shell
npm run cli -- runs session-summary overnight
npm run cli -- runs session-summary overnight --next --max-polls 30 --interval-ms 10000
npm run cli -- runs session-summary overnight --next --limit 20
npm run cli -- runs session-summary overnight --next --limit 20 --offset 20
npm run cli -- runs session-summary overnight --next --older-than-ms 120000 --commands-only --format shell
npm run cli -- runs session-review overnight --include-stopped --lines 40
npm run cli -- runs session-review overnight --include-stopped --next
npm run cli -- runs session-review overnight --include-stopped --next --limit 20
npm run cli -- runs session-review overnight --include-stopped --next --limit 20 --offset 20
npm run cli -- runs session-review overnight --include-stopped --next --commands-only --format shell
npm run cli -- runs session-review overnight --include-stopped --next --commands-only --branch-action resume_branch --format shell
npm run cli -- runs session-apply overnight --include-stopped --branch-action resume_branch --run <run-id> --dry-run
npm run cli -- runs session-apply overnight --source status --include-stopped --branch-action resume_branch --run <run-id> --dry-run
npm run cli -- runs session-apply overnight --include-stopped --branch-action resume_branch --apply-id overnight-resume-1 --resume
npm run cli -- runs session-apply overnight --include-stopped --branch-action resume_branch --apply-id overnight-resume-1 --resume --resume-filter failed
npm run cli -- runs session-applies overnight --apply-id overnight-resume-1
npm run cli -- runs session-applies overnight --server --apply-id overnight-resume-1
npm run cli -- runs session-applies overnight --server --action-queue
npm run cli -- runs session-applies overnight --server --action-queue --format shell
npm run cli -- runs session-applies overnight --server --action-queue --execute-next --apply-action retry_failed
npm run cli -- runs session-applies overnight --server --action-queue --execute-queued --max-actions 5
npm run cli -- runs session-applies overnight --server --action-queue --execute-queued --until-empty --max-actions 5 --max-polls 20 --interval-ms 5000
npm run cli -- runs session-applies overnight --server --action-queue --execute-queued --until-empty --detach --worker-id overnight-apply-worker --max-actions 5 --max-polls 20 --interval-ms 5000
npm run cli -- runs session-apply-action-workers overnight --lines 40
npm run cli -- runs stop-apply-action-workers overnight --worker-id overnight-apply-worker --retire
npm run cli -- runs restart-apply-action-workers overnight --worker-id overnight-apply-worker --include-retired
npm run cli -- runs session-applies overnight --server --action-executions
npm run cli -- runs session-applies overnight --server --apply-id overnight-reset-1 --ack-reset-audit
npm run cli -- runs session-applies overnight --summary
npm run cli -- runs session-applies overnight --action-queue
npm run cli -- runs session-applies overnight --action-queue --format shell
npm run cli -- runs session-applies overnight --action-queue --format shell --checkout-dir ./checkouts/overnight-results --changed-only
npm run cli -- runs session-applies overnight --summary-group resume-needed --format shell
npm run cli -- runs session-applies overnight --summary-group ready-to-review --format shell --checkout-dir ./checkouts/overnight-results --changed-only
npm run cli -- runs session-applies overnight --summary-group drain-prefixes --format shell
npm run cli -- runs session-applies overnight --continue-drains --drain-prefix overnight-drain --max-polls 5
npm run cli -- runs session-drains overnight --format shell
npm run cli -- runs session-drain-continuations overnight --queue --drain-prefix overnight-drain --dry-run --max-polls 5
npm run cli -- runs session-drain-continuations overnight --execute-queued --max-continuations 5
npm run cli -- runs session-drain-continuations overnight --execute-queued --detach --worker-id overnight-drain-worker
npm run cli -- runs session-drain-workers overnight --lines 40
npm run cli -- runs stop-drain-workers overnight --worker-id overnight-drain-worker --retire
npm run cli -- runs restart-drain-workers overnight --worker-id overnight-drain-worker --include-retired
npm run cli -- runs session-drain-continuations overnight --reset-running --older-than-ms 600000
npm run cli -- runs session-drain-continuations overnight --execute-next
npm run cli -- runs session-drain-continuations overnight --execute <continuation-id>
npm run cli -- runs session-drain-continuations overnight --status queued,running,failed
npm run cli -- runs session-drain-continuations overnight
npm run cli -- runs session-applies overnight --ready-results --format shell
npm run cli -- runs session-applies overnight --ready-results --format shell --checkout-dir ./checkouts/overnight-results --changed-only
npm run cli -- runs session-review overnight --include-stopped --checkout-dir ./checkouts/overnight-review
npm run cli -- runs session-apply overnight --source watch --action retry_failed --limit 1 --dry-run
npm run cli -- runs session-apply overnight --source watch --branch-action resume_branch --include-stopped --limit 1 --dry-run
npm run cli -- runs session-apply overnight --source watch --action retry_failed --limit 1 --until-empty --max-polls 5
npm run cli -- runs session-apply overnight --source watch --action retry_failed --limit 1 --continue-prefix overnight-drain --until-empty --max-polls 5
npm run cli -- runs session-watch overnight --max-polls 5
npm run cli -- runs session-watch overnight --recoverable --include-stopped --next --max-polls 5
npm run cli -- runs session-watch overnight --recoverable --include-stopped --next --checkout-dir ./checkouts/overnight-watch
npm run cli -- runs session-watch overnight --recoverable --include-stopped --next --action-queue --checkout-dir ./checkouts/overnight-watch
npm run cli -- runs session-watch overnight --recoverable --include-stopped --next --action-queue --until-empty --max-polls 60 --interval-ms 10000 --checkout-dir ./checkouts/overnight-watch
npm run cli -- runs session-watch overnight --recoverable --include-stopped --next --action-queue --commands-only --format shell --checkout-dir ./checkouts/overnight-watch
npm run cli -- runs session-logs overnight --lines 40
npm run cli -- runs recover-session overnight --dry-run
npm run cli -- runs resume-session overnight --worker-id worker-a --dry-run
npm run cli -- runs resume-session overnight --next
npm run cli -- runs stop-session overnight --recover
npm run cli -- runs restart-session overnight --recover
npm run cli -- runs supervise --agents <agent>,<agent> --session overnight --workers 3 --recover --include-stopped
npm run cli -- runs dispatch --agents <agent>,<agent> --objective "one bounded task" --session overnight --workers 3 --boot --recover
npm run cli -- runs dispatch --agents <agent>,<agent> --objectives-file ./tasks.txt --session overnight --workers 3 --boot --recover --include-stopped
npm run cli -- runs dispatch --agents <agent>,<agent> --objectives-file ./tasks.txt --assignment round-robin --session overnight --workers 3 --boot --recover
npm run cli -- runs dispatch --agents <agent>,<agent> --objectives-file ./tasks.txt --assignment round-robin --session overnight --workers 3 --dry-run
npm run cli -- runs stop-matching --agents <agent>,<agent> --status planned
npm run cli -- runs monitor --agents <agent>,<agent> --status planned,running
npm run cli -- runs monitor --agents <agent>,<agent> --status planned,running,stopped --next
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

`runs dispatch` queues the requested objectives, starts the detached worker
session, and returns an `actions` block with the exact `session-status`,
`session-watch`, `monitor --next`, `session-review`, branch queue, results,
checkout, and stop/recover/restart/resume commands for that session. The dry-run form returns
the same action commands and any recoverable branch preview without queuing
runs, requeueing branches, or starting workers, so the local control-plane flow
can be reviewed before launching a multi-agent batch.
`runs supervise` returns the same action commands when it starts detached
workers for already queued runs.

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
  commands for branch-native review. The command block includes a direct
  `runs review` command for compact diff review from the same checkout path.
  Add `--checkout --checkout-dir <path>` to clone or refresh the run branch and
  include changed files/commits in the same payload.
- `runs inspect-result <run> --checkout-dir <path>` is the result-commit view:
  it fetches the run branch, anchors the base ref locally, and reports the exact
  result commit, commits ahead, name-status file list, shortstat/stat output,
  result links, and copyable `git show`/`git diff` commands. If the run has no
  result commit yet, it returns a structured reason plus the relevant
  resume/review commands without mutating branch state.
- `runs inspect-result <run> --server` calls
  `GET /api/runs/:id/result-inspection` and returns the same durable run,
  branch, result commit, link, and next-command metadata without cloning or
  refreshing a local checkout.
- `runs checkout <run> --dir <path>` clones or refreshes the run branch into a
  local Git checkout and reports base/head commits, commits ahead, and changed
  files so the branch state can be reviewed directly.
- `runs review <run> --checkout-dir <path>` is the compact single-run review
  path: it checks out the run branch and returns changed files, commits, and the
  exact `git diff`/`git log` commands for that branch.
- `runs checkout-session <name> --dir <path>` checks out every completed or
  stopped branch run from a detached worker session under `<path>/<run-id>`.
  Add `--resumable` to pull only stopped branches without result commits, or
  `--worker-id <id>` to pull only branches claimed by one worker. Each checkout
  row preserves the run objective, worker claim, and session location so local
  branch review still has ownership context.
- `runs branches --session <name>` adds ownership context to each listed branch
  run so an operator can see its objective, worker claim, and whether it is
  unassigned, owned by that session, or claimed by another worker. Branch rows
  also surface completed-without-result warnings directly in the branch queue.
  Add `--next --commands-only --format shell` to print one runnable
  resume/review command per branch.
- `runs results --session <name>` reports completed and stopped branch runs for
  a worker session with GitHub branch/result links and warnings for completed
  runs that do not have a recorded result commit. Session results include
  whether each visible run is still unassigned, claimed by a session worker, or
  claimed by another worker. The payload also includes a top-level
  `resultCommits` index with run id, branch name, result commit URLs, and
  checkout/review/inspect commands so durable result commits can be scanned
  without walking nested agent rows. Add `--checkout-dir <path>` to clone or refresh
  each listed run branch under `<path>/<run-id>` and include changed
  files/commits in the result payload. Add `--changed-only` with `--checkout-dir`
  to show only branches whose checkout has changed files, commits, or a review
  error, or `--changed-path <path[,path]>` to show only runs that changed
  specific paths. Result rows also include `commands.checkoutBranch`,
  `commands.reviewRun`, `commands.inspectRun`, and resumable
  `commands.resumeBranch` commands for branch-native inspection. Add `--next`
  to return the compact ordered review/resume commands for the visible result
  rows. Add `--limit <n>` with `--next` to bound top-level result commit and
  review/resume queues while preserving exact summary counts, and combine it
  with `--offset <n>` to page through the queue. Paged JSON includes
  `filter.hasMore` and `filter.nextOffset` so automation can continue the queue
  without recomputing totals. Add
  `--run <run-id[,run-id]>` to narrow a result snapshot or command
  queue to specific branch runs from a session/apply queue. Add
  `--max-polls` and `--interval-ms` to keep emitting result snapshots while a
  long session runs. Add `--server` with `--session` to read the durable
  worker-session branch index from `GET /api/worker-sessions/:name/branches`
  instead of requiring the local session record. The server-backed results view
  supports `--run`, `--next`, `--commands-only`, `--limit`, `--offset`, and
  `--format shell` for branch-native result/resume inspection; add
  `--branch-action resume_branch|review_branch` to ask the server for only the
  resume or review side of the branch queue. Checkout diff filters still
  require the local checkout-backed results path. The backing branch endpoint
  accepts the same run, branch-action, and page filters, so large sessions can
  ask the server for a bounded branch queue instead of materializing every run
  in the CLI first.
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
- `POST /api/runs/:id/resume-branch` is the server-owned single-branch resume
  path for stopped runs without result commits. Pass `{ "dryRun": true }` to
  validate resumability without changing state, or `{ "workerId": "..." }` to
  tag the durable requeue message.
- `GET /api/runs/:id/resume-inspection` backs
  `runs resume-branch <run> --inspect` with read-only resume readiness metadata:
  branch/result links, running-sandbox blockers, exact resume/dry-run commands,
  and the next branch action before any state is requeued.
- `POST /api/worker-sessions/:name/resume-branches` is the server-owned bulk
  session resume path. It reads the durable worker-session record, resumes
  stopped branches without result commits that belong to the session workers
  (plus unassigned stopped branches when no `workerId` is supplied), and accepts
  `{ "dryRun": true, "workerId": "...", "runIds": ["..."], "limit": 1 }` for
  guarded previews or bounded action-queue execution. Each row includes the
  same `resumeInspection` readiness payload as `runs resume-branch --inspect`,
  so bulk dry-runs and skipped branches expose their blocker reason before any
  state changes.
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
session for one or more agents. Add `--until-empty --wait` for a bounded
foreground supervise call that waits for the worker session to exit and returns a
final status summary, `nextStep`, and branch review/result/watch/log/stop
commands. `runs dispatch` uses the same recovery flags after queueing its
objective file and before starting workers; add `--until-empty --wait` to wait
for that bounded dispatch session and receive the same final status and
branch-native next actions. If the wait reaches `--max-polls` while workers are
still alive, `nextStep` points to the compact `runs session-summary --next`
poller, and the command set still includes full watch/log/stop commands. `runs work` drains
already planned runs for one or more agents. Use `--until-empty` to keep
claiming batches until the queue is idle, or `--loop` to poll for longer CLI
worker sessions. Add `--recover` to
requeue unfinished running runs that no longer have a running sandbox before
the worker claims new work. Add `--resume-stopped` to include stopped unfinished
runs in the worker queue; those branches are bootstrapped by default unless
`--no-bootstrap` is also passed. Before a worker picks up a stopped branch, it
calls the same server-backed resume inspection used by
`runs resume-branch --inspect`, includes that readiness payload in the processed
row, and skips the branch with the server-provided reason if it is not ready.
A worker only resumes stopped branches that are unassigned or already claimed by
that worker id; use `--recover --include-stopped`
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
stdout/stderr, `runs sessions --summary --next` to see the next action for every
recorded session in one fleet snapshot, including a top-level `resultCommits`
queue and a top-level `resumableBranches` queue for branch-native inspection
across sessions. With `--next`, fleet snapshots also include top-level
`nextActions` counts and an `actionQueue` of runnable per-session next-action
commands, plus `branchActions` counts and a `branchActionQueue` of runnable
resume/review commands for durable run branches across sessions. Sessions with
failed drain continuations surface `reset_failed_drain_continuations`, and stale
`running` drain continuations surface `reset_running_drain_continuations`, as
the session next action before ordinary watch/recover guidance; add
`--older-than-ms` to tune when running continuation records count as stale.
The summary reads the durable local continuation records directly, so fleet
triage does not need one server request per session just to detect stuck drains.
Add `--limit <n>` to scan only the most recently touched local session records,
and combine it with `--offset <n>` to page through older records. This keeps
fleet snapshots bounded in long-lived checkouts with large
`.threadbeat/worker-sessions/` history. Paged output includes
`filter.hasMore` and `filter.nextOffset` for CLI loops over local session pages.
Add `--max-polls` and `--interval-ms` to stream newline-delimited fleet snapshots while long
worker sessions run. Add `--needs-action` with `--next` to hide sessions whose
next action is only `continue_watch`, `--action <name>` to show only matching
session next-actions, or `--branch-action resume_branch|review_branch` to narrow
the branch command queue without mutating any run branch, leaving restart,
recover, result-inspection, and archive rows in the fleet queue. Add
`--commands-only` with `--next` to emit only the runnable session and branch
commands for shell-friendly triage, or add `--format shell` to print one
copyable command per line. Use `runs archive-sessions --dry-run`
to preview archiving dead local session records without touching run records or Git branches, and
`runs stop-session <name>` to terminate the recorded process
group, escalating to a forced stop if the worker ignores `SIGTERM`. Add
`--recover` to `runs stop-session` to requeue unfinished runs claimed by that
session's workers when those runs do not have a running sandbox. Add
`--include-stopped` to also requeue unfinished stopped branches in the same
stop/recover step.
Use `runs session-actions <name>` when returning to an existing session and you
only need the exact status/wait/watch/summary/fleet-summary/monitor/review/results/
needs-action/changed-results/checkout/logs/stop/recover/resume/restart/archive commands.
Use `runs session-wait <name>` to attach a foreground wait to an already running
or recently finished detached session; it returns the same final/timeout summary
and branch-native next action commands as `dispatch --wait` and
`supervise --wait`. Add `--recoverable --include-stopped` when the wait should
finish by pointing at recover/restart/resume commands instead of plain review
when workers are dead and unfinished branches remain.
Add `--recoverable` to `runs session-status` or `runs session-watch` to include
a dry-run recovery preview in the live session snapshot; combine it with
`--include-stopped` to surface unfinished stopped branches too. `session-status`
also includes `branchNextSteps` with checkout/resume/recover commands when the
recoverable preview is enabled. With `--next`, `session-status` also includes
restartable `drainWorkerNextSteps` for stopped drain-continuation workers and
`drainContinuationResetNextSteps` for failed or stale `running` drain
continuations. Add
`--next --commands-only --format shell` to `runs session-status --recoverable`
to print copyable branch-resume, drain-worker restart, and continuation-reset
commands; use
`--branch-action resume_branch` to keep the queue explicitly scoped to branch
resumes. Add `--next` to `runs session-watch` to stream only
the compact restart/recover/resume command
queue for each poll instead of the full session snapshot. The compact watch
payload also includes `branchNextSteps` for stopped branch rows, with objective,
worker ownership, checkout/review/inspect/watch/resume commands, and
recoverability when available. It also includes `drainWorkerNextSteps` when a
stopped drain-continuation worker can be restarted or queued drain continuations
are waiting without a live worker, plus `drainContinuationResetNextSteps` when
failed or stale `running` drain continuations should be reset before execution
resumes.
Pass `--checkout-dir` to choose where those branch commands materialize local
checkouts.
`runs session-summary <name>` rolls up worker liveness, run statuses, completed
result commits, and resumable stopped branches for that session's agents. Add
`--max-polls` and `--interval-ms` for a compact newline-delimited status feed
while a long worker session is running. With `--next`, dead sessions that have
no run records point at `runs archive-sessions --session <name> --dry-run` so
local metadata cleanup remains explicit and branch-preserving. The summary
payload includes a top-level `resultCommits` list with run ids, branch names,
commit SHAs, worker ownership, and checkout/review/inspect commands for
branch-native result inspection, plus a top-level `resumableBranches` list with
checkout/review/inspect/resume commands for stopped branches that do not have a
result commit yet. Failed and stale `running` drain continuations appear as
`drainContinuationResetNextSteps` and become the session `nextStep` until reset;
add `--older-than-ms` to choose the age threshold used by running-continuation
reset commands.
The reset detection scans local continuation records, while the emitted reset
command still performs the server-owned mutation.
Add `--commands-only` with `--next` to emit only the runnable session and branch
command queue, or `--format shell` to print copyable commands;
use `--action <name>` or `--branch-action resume_branch|review_branch` to narrow
that queue without mutating any branch. Add `--limit <n>` to keep the
per-session result/resume rows and branch command queue bounded, and combine it
with `--offset <n>` to page later rows while preserving exact total counts in
the summary; `filter.hasMore` and `filter.nextOffset` identify the next page.
`runs session-review <name> --include-stopped` is the read-only operator summary
for a long-running session: worker liveness, agent run status, completed result
branches with checkout/inspect commands, resumable branch list with concrete
checkout/resume commands, dry-run recovery candidates, ordered `nextSteps`, and
recent worker logs in one payload. Add `--next` to return only the compact
summary, ordered session-level next-step commands, and the per-branch
review/resume queue with checkout, inspect, review, and resume commands on each
row. Each branch queue row includes objective, worker ownership, and session
location so the next action is self-contained. Stopped branch rows also mark
whether they are recoverable and include the matching recover command when
`--include-stopped` finds a stale stopped branch. The full snapshot also
includes an `actions` block with the exact restart, recover, resume,
branch-queue, and changed-results commands to run next. Result rows include
`commands.reviewRun`
for compact branch-native inspection of one completed run. `runs results --next`
keeps objective, worker ownership, branch state, and checkout/review/inspect
commands on each queue row so changed-result review can stay branch-native.
Add `--commands-only` with `--next` to reduce that snapshot to runnable
commands, or `--format shell` to print one copyable command per line. Use
`--action <name>` or `--branch-action resume_branch|review_branch` with
`--next` to narrow a session-review queue to one class of recovery, result
inspection, or branch resume commands without touching the branch state. Add
`--limit <n>` with `--next` to bound session-level and branch-level queue rows,
and combine it with `--offset <n>` to page through later rows; with
`--commands-only`, the same page bounds the combined runnable command stream
while the filter metadata preserves exact unbounded totals and exposes
`filter.hasMore` plus `filter.nextOffset`. Add
`runs session-apply <name> --action ...` or `--branch-action ...` to execute an
explicitly filtered queue; use `--dry-run`, `--run <id>`, `--limit`, and
`--concurrency` to preview or bound that execution before changing run state.
Apply output includes an `applySelection` block with the total command queue,
filtered candidates, selected commands, unselected commands, and `hasMore`, so
bounded operators can tell when a `--limit` pass intentionally left more work in
the queue.
Use `--source status --branch-action resume_branch` when the apply should come
from the lighter `session-status --recoverable --next` queue instead of the
full session review snapshot; that resume path is executed through
`POST /api/worker-sessions/:name/resume-branches`, so bounded status-source
applies do not shell out per branch. The same status source also accepts
`--action reset_failed_drain_continuations` or
`--action reset_running_drain_continuations` when the next step is to clear
drain-continuation records before resuming work. Status-source drain resets use
the server drain-continuation reset APIs directly, so bounded reset applies do
not spawn a nested CLI command just to mutate continuation records.
Use `--source branches --branch-action resume_branch` to apply directly from the
server-backed `runs session-branches <name> --server --resumable` queue. This
keeps branch-native resume execution tied to the durable worker-session branch
readout while still writing the same apply ledger and calling
`POST /api/worker-sessions/:name/resume-branches` once for the selected run ids.
Each non-dry apply writes `.threadbeat/worker-sessions/apply/<session>/<apply-id>.json`;
set `--apply-id <id>` and rerun with `--resume` to skip commands that already
exited cleanly in that recorded apply. Add `--resume-filter failed`, `pending`,
or `failed,pending` to retry only the failed commands, only commands that never
started, or both. Use `runs session-applies <name>` to list those apply records,
`runs session-applies <name> --server` to inspect the same durable records
through the server API, `runs session-applies <name> --server --action-queue`
to read server-computed retry, resume, and reset-audit actions, or add
`--format shell` to print the runnable command lines. Add `--execute-next`
with `--apply-action retry_failed`, `resume_pending`, or
`inspect_drain_continuation_resets` to execute one queued server action, or use
`--execute-queued --max-actions <n>` to execute a bounded batch and stop on the
first failed action unless `--continue-on-failure` is set. Add `--until-empty`
with `--max-polls <n>` and `--interval-ms <ms>` to keep polling until the queue is
empty, a command fails, the poll cap is reached, or the next action would repeat
an action already executed in that loop. Add `--detach --worker-id <id>` to
leave that executor running in the background, then
inspect it with `runs session-apply-action-workers`, stop or retire it with
`runs stop-apply-action-workers`, and restart the stored command with
`runs restart-apply-action-workers`. Detached apply-action workers record their
latest execution summary in `lastRun`, including exit counts, stop reason,
remaining queued actions, and per-poll counts; use
`runs session-apply-action-workers <name> --server` or
`GET /api/worker-sessions/:name/apply-action-workers` to inspect the same
summary through the server. Use `runs stop-apply-action-workers <name> --server`,
`runs restart-apply-action-workers <name> --server`, or
`POST /api/worker-sessions/:name/apply-action-workers/stop` and
`POST /api/worker-sessions/:name/apply-action-workers/restart` to recover those
workers through the server. Use `runs session-apply-action-workers-next <name>
--server` or `GET /api/worker-sessions/:name/apply-action-workers/next` to list
stopped apply-action workers with exact restart, inspect, and retire commands.
Use `runs session-control-plane-status <name> --server` or
`GET /api/worker-sessions/:name/control-plane-status` for one aggregate status
view across watch workers, apply-action workers, apply queues, drain
continuations, branch recovery, and recovery suggestions. The `branches` block
counts stopped run branches that are ready to resume versus blocked by a running
sandbox, and includes exact bulk resume, dry-run, and branch-inspection
commands. Non-dry-run branch recovery writes durable records under
`.threadbeat/worker-sessions/branch-recovery-executions/<session>/`; inspect
them with `runs session-branch-recovery-executions <name> --server` or
`GET /api/worker-sessions/:name/branch-recovery-executions`. The aggregate
control-plane status also embeds recent branch-recovery executions and status
counts so operators can see recent resume attempts next to the current branch
queue. Bounded resume calls prioritize ready stopped branches before applying
their limit, so `runs resume-session <name> --next` does not get stuck on a
blocked branch while a resumable branch is waiting behind it.
Server-executed actions are also written to
durable execution records, and `runs session-applies <name> --server
--action-executions` lists those records,
`runs session-applies <name> --server --apply-id <id> --ack-reset-audit` to
acknowledge a drain-continuation reset audit through the server API, or
`--apply-id <id>` to inspect the failed executions, pending commands,
affected runs, drain-continuation reset effects, exact resume commands, and
branch-native inspect/checkout/review commands for one recorded apply. Add
`--summary` to group recorded applies into resume-needed, ready-to-review,
drain-continuation reset, waiting, and watch-drain prefix buckets. Reset
summaries report reset counts, continuation IDs, reset reasons, and the
commands that performed the reset. Drain prefix summaries report poll apply
IDs, whether the drain reached an empty queue, and the next apply ID that would
continue the same prefix. Add
`--action-queue` for a compact JSON preview of the next actionable command per
apply record, or `--action-queue --format shell` to print that queue as runnable commands. The
queue prioritizes retry/resume commands before result-review commands, then
includes reset-audit inspection commands for drain-continuation reset applies;
pass `--checkout-dir`, `--changed-only`, or `--changed-path` through when it
includes result review. Add
`--summary-group resume-needed --format shell` to print only retry/resume
commands for apply records that still need execution, or
`--summary-group ready-to-review --format shell` to print only review-ready
result commands from apply records whose affected runs now have result commits.
Use `--summary-group drain-prefixes --format shell` to print only incomplete
watch-drain continuation commands, or
`--summary-group drain-resets --format shell` to print only reset-audit
inspection commands. Use `runs session-drains <name>` to fetch the same durable
watch-drain continuation readiness through the server API; `--format shell`
prints only the runnable continuation commands. Use
`--continue-drains` to execute those server-backed continuations directly; add
`--drain-prefix <prefix[,prefix]>` to target a subset and `--dry-run` to run the
nested continuation previews without mutating apply records. Each continuation
batch is written under `.threadbeat/worker-sessions/drain-continuations/<name>`;
`runs session-drain-continuations <name>` reads those durable attempt records
back through the server, and `--queue` creates a server-owned queued attempt
record without executing it yet. Queued records can be drained in a bounded
server loop with `runs session-drain-continuations <name> --execute-queued
--max-continuations 5`, drained one at a time with `--execute-next`, or a
specific queued record can be executed with `--execute <continuation-id>`. All
execution paths run the stored commands through the server and persist the same
record as `running`, then `executed` or `failed` with command results. A
non-zero nested drain command marks the attempt `failed`, so
`--status failed` finds drains that need operator attention without scanning
`continueDrains.failed` inside executed records. Add
`--status queued,running,failed` to inspect pending, in-flight, or failed
continuation records without mixing in completed attempts. Use `--reset-failed`
to move failed attempts back to `queued` after inspecting the error; add
`--continuation <id>` to reset a specific failed attempt. If a host crash leaves
a continuation stuck as `running`, use `--reset-running` to move it back to
`queued`; add `--older-than-ms 600000` to only reset records whose `startedAt`
timestamp is at least ten minutes old. Add `--detach` with
`--execute-queued` to leave the bounded server drain running in the background;
`runs session-drain-workers <name>` returns the durable worker PID, command, log
paths, liveness, and recent stdout/stderr lines. Add `--server`, or call
`GET /api/worker-sessions/:name/drain-workers`, to inspect the same drain-worker
records through the control-plane server. Use
`runs stop-drain-workers <name> --server --worker-id <id>` to terminate one drain
worker process group through the server and persist stop metadata; add `--retire`
to hide it from default worker listings while keeping the durable record
available with `runs session-drain-workers <name> --server --include-retired`.
Use `runs restart-drain-workers <name> --server --worker-id <id>` to restart a
stopped or lost worker from its saved command and log paths; pass
`--include-retired` when the saved record was intentionally retired.
Apply summaries also include run-filtered
`runs results --session <name> --run <id> --next` commands so result inspection
can continue from the exact affected branches. When any affected run now has a
result commit, apply summaries add a `reviewReadyResults` command for the
run-filtered result review queue. Add `--ready-results --format shell` to print
only those review-ready result commands across recorded applies, and pass
`--checkout-dir`, `--changed-only`, or `--changed-path` through to the generated
result-review commands. JSON apply summaries also include each affected run's
current status, result commit, worker location, and next branch action when the
worker session is still available. Add
`--action-queue` to `runs session-watch <name>` to include the same apply queue
inside live watch snapshots; with `--next`, the compact watch summary includes
apply action counts, including actionable, acknowledged, and total reset-audit
apply counts, alongside worker and branch recovery counts, and generated
result-review commands use the watch checkout directory. Add `--until-empty`
with `--next` to keep polling until the watch queue has no recovery, branch
resume, or apply actions left, or until `--max-polls` is reached; this is a
bounded wait and does not execute queued commands. Add `--watch-id <id>` to
persist the watch attempt, its poll outputs, and the final stop reason under
`.threadbeat/worker-sessions/watch/<session>/`; inspect those durable attempts
with `runs session-watches <name> [--watch-id <id>]`. Use
`runs start-session-watch-worker <name> --watch-id <id>` for a detached bounded
watch loop that keeps the same durable watch record plus stdout/stderr worker
logs, and inspect or stop it with `runs session-watch-workers` and
`runs stop-session-watch-workers`. If a watch worker is stopped without being
retired, `runs session-watch <name> --next` and `runs session-status <name>
--next` include a `restart-session-watch-workers` next step. The server exposes
the same durable worker lifecycle at `POST /api/worker-sessions/:name/watch-workers`,
`GET /api/worker-sessions/:name/watch-workers`, and
`POST /api/worker-sessions/:name/watch-workers/stop`, and
`POST /api/worker-sessions/:name/watch-workers/restart`; use
`GET /api/worker-sessions/:name/logs?lines=80` to inspect the durable session
record, worker liveness, worker log tails, and next diagnostic commands,
`GET /api/worker-sessions/:name/next` to combine that snapshot with stopped
watch-worker restart cues and a recommended next command,
`GET /api/worker-sessions/:name/branches?resumable=true` to inspect
branch-native result commits, resumable stopped branches, GitHub links, and
review/resume commands through the server API, or
`runs session-branches <name> --server --resumable` for the same readout from
the CLI. Add `--commands-only --format shell` to print only the recommended
review/resume commands from that server-backed branch queue, and use
`GET /api/worker-sessions/:name/watch-workers/next` to surface stopped worker
restart actions through the API. Add `--commands-only
--format shell` to print the watch queue as runnable commands, including
recovery, branch resume, and apply action-queue commands. Add
`--apply-action inspect_drain_continuation_resets` with `--action-queue` to
print only reset-audit apply inspection commands from the watch queue. Use
`runs session-apply <name> --source watch` with an explicit `--action` or
`--branch-action` to execute a filtered slice of that watch queue through the
durable apply ledger, or use `--apply-action inspect_drain_continuation_resets`
to execute only reset-audit apply commands; resume and drain-continuation
commands preserve the same apply-action filter. After inspecting a reset-audit
apply, run `runs session-applies <name> --apply-id <id> --ack-reset-audit` to
remove that audit from the live watch queue while keeping the durable apply
record. Add `--until-empty --max-polls <n>` to repeatedly take a
bounded watch snapshot and write one apply record per poll until the filtered
queue is empty. Add `--continue-prefix <prefix>` with `--until-empty` to keep
draining from the next recorded `<prefix>-NNN` apply ID; it refuses completed
prefixes and prefixes that stopped on failed executions so the durable ledger
stays explicit. Each drain poll records the nested apply selection's
`unselectedQueueCommands` and `hasMore` values, which keeps bounded drains
inspectable when `--limit` leaves additional commands for a later poll. The
top-level `untilEmpty` summary mirrors the last poll's `unselectedQueueCommands`
and `hasMore`, and adds `stoppedReason` so operators can distinguish an empty
queue, dry-run preview, failure, or exhausted `--max-polls` without inspecting
every poll record.
`--checkout-dir <path>` to include local checkouts for completed/stopped run
branches plus a top-level `changedResults` list in the same snapshot. Add
`--changed-only` or `--changed-path <path[,path]>` with `--checkout-dir` to
make the review snapshot show only branches with local changes that matter.
`runs recover-session <name>` requeues stale runs claimed by that session's
workers without stopping or restarting the worker group; add `--dry-run` to
preview the affected runs first. Add `--include-stopped` to also requeue
unfinished stopped branch runs for that session's agents. The response includes
the next branch-native command: wait on live workers, restart dead workers, or
review the session when nothing changed.
`runs resume-session <name>` is the branch-only bulk resume path for a detached
worker session: it requeues stopped runs with no result commit while leaving
completed result branches alone. Add `--worker-id <id>` to target only that
worker's claimed stopped branches, `--dry-run` to preview the requeue first, or
`--next`/`--limit <n>`/`--run <id[,id]>` for bounded server-side branch recovery
from the control-plane queue. Like recovery, it returns the next
wait/restart/review command to keep the operator flow attached to the durable
branch session.
`runs branches --session <name>` is the no-checkout branch ledger for a session:
each row includes branch/result state, GitHub branch/result links, and exact
checkout/review/inspect/resume commands. Add `--next` to return only the ordered
branch review/resume queue while preserving objective, worker ownership, session
location, missing-result warnings, and the same per-run command set.
`runs results --session <name>` shows the branch-native output surface for those
runs without creating PRs: branch compare/tree links, result commit links when
available, missing-result warnings, top-level result/resumable/changed counts,
copyable checkout/review/inspect commands, and a `changedFiles` index when local
checkouts are requested with `--checkout-dir`. Add `--next` to emit only the
review/resume commands for the visible result rows, or `--limit <n>` with
`--next` to keep large session queues bounded. Add `--worker-id <id>` to review
only branches claimed by one worker.
`runs restart-session <name> --recover` respawns dead workers from the recorded
session command and requeues stale claimed runs before the replacements start.
Add `--wait` to poll the restarted session in the foreground and return the same
final or timeout next actions as `dispatch --wait`. Add `--resume-stopped` when
the restarted workers should continue stopped branch runs from the same session;
this updates the recorded worker command for later session inspection and
restarts.
`runs watch` polls one run's status and messages until it completes, fails, or
stops, and each snapshot includes checkout, review, inspect, and resumable
branch commands for the run. `runs backlog` reports run counts by status for one or more agents and
includes `resumableStopped` for stopped branch runs that `--resume-stopped` can
pick up. `runs branches` lists completed and stopped branch runs across agents,
including base refs, branch names, result commits, and resumable stopped runs;
pass `--session <name>` to inspect the branch state for a detached worker group,
add `--worker-id <id>` to focus on one worker's claimed branches, or add
`--resumable` to show only stopped branches without a result commit.
Use `runs resume-branch <run>` to requeue one of those stopped branch runs back to
`planned` without touching the rest of the session; the CLI uses
`POST /api/runs/:id/resume-branch`, so API clients can perform the same guarded
single-branch resume without shelling out. `runs resume-session <name>` now uses
`POST /api/worker-sessions/:name/resume-branches` for the same guarded resume
logic across all resumable branches in a durable worker session; add `--next`
to execute only the first ready branch from that queue.
`runs workers` groups running runs by the `worker_id` that claimed them.
`runs stop-matching --status planned` cancels queued runs for one or more
agents; include `running` in the status list to stop active run sandboxes too.
`runs monitor` snapshots all runs for one or more agents, including branch names,
result commits, sandbox states, recent message types/text, and a `resumable`
marker only for stopped branches without a result commit. Use `--status
planned,running,stopped` to focus the snapshot on queued, active, or resumable
work. Add `--next` to emit the compact command queue for visible rows with
objective, branch, result, warning, and per-row command fields: claim planned
runs, watch active runs, resume stopped branches without result commits, or
inspect terminal/result rows. Each row also includes checkout/review commands;
pass `--checkout-dir <path>` to choose where those branch-native inspection
commands materialize local checkouts. `runs step` executes one explicit shell
command and can optionally finalize the run branch.

## Phases

See [docs/modal-control-plane-plan.md](docs/modal-control-plane-plan.md).
