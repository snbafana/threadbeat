# Threadbeat Modal Rewrite Handoff

This file is the working handoff for the next agent taking over the Threadbeat Modal control-plane rewrite.

## User Intent

The user wants a clean rewrite around a Modal-backed control plane for git-backed agents.

Important constraints from the user:

- Keep Pi running in the server separate from Pi running inside agent sandboxes.
- Do not blur server-side orchestration with agent runtime work.
- Build the Modal sandbox implementation from scratch end to end.
- Keep branch planning unified.
- Keep code storage / hosted git as its own phase.
- Git-backed agents should be cloneable repos, with self-improvement happening through branch/diff/eval/promote, not active in-place mutation.
- For now, do not worry about a full control-plane primitive beyond the API/CLI/server lifecycle needed to spin sandboxes up/down and inspect state.
- Keep implementation moving in small durable commits with tests.

## Current Repo State

Working directory:

```text
/Users/snbafana/Documents/personal/Scratch/projects/threadbeat
```

Current branch:

```text
sandbox-agent-runtime
```

The branch is pushed to origin and was clean at this handoff.

Latest commits:

```text
pending next commit: Add Modal CLI live smoke
d8959b2 Add runs step CLI
10b5537 Add running sandbox cleanup
2850bfe Add run sandbox restart
688c993 Reuse running sandboxes for runs
3305bad Add run status inspection endpoint
d2b7d2b Add run stop lifecycle endpoint
dbf5845 Track run lifecycle state
7dfadd1 Add Modal live smoke
c44891d Finalize run branches from sandboxes
6720e16 Use gh auth token for GitHub smoke
354cab9 Execute commands in run sandboxes
2fba821 Push hosted run branches after bootstrap
142b8e6 Create run branches during bootstrap
000c98b Resolve hosted clone URLs for bootstrap
8ed75b0 Bootstrap run sandboxes on demand
```

## Architecture Implemented So Far

The repo now has a Fastify/libSQL control-plane server with CLI wrappers and dry-run/live provider seams.

Core tables:

- `agents`
- `code_storage_repos`
- `agent_runs`
- `heartbeats`
- `sandboxes`
- `messages`

Core paths:

- `src/server.ts`: HTTP API.
- `src/db.ts`: libSQL persistence.
- `src/modalProvider.ts`: sandbox provider boundary with dry-run and live Modal implementations.
- `src/sandboxService.ts`: sandbox start/exec/bootstrap/finalize/stop behavior plus message emission.
- `src/sandboxBootstrap.ts`: git clone/checkout/push bootstrap commands.
- `src/hostedGit.ts`: hosted git provider boundary.
- `scripts/threadbeat-cli.ts`: CLI against the server API.
- `scripts/smoke.ts`: broad local integration smoke test.
- `scripts/modal-live-smoke.ts`: real Modal sandbox smoke, skipped when credentials are missing.

## API/CLI Surface

Implemented API:

- `GET /health`
- `GET /api/agents`
- `POST /api/agents`
- `GET /api/agents/:id`
- `GET /api/agents/:id/repository`
- `GET /api/agents/:id/code-storage`
- `POST /api/agents/:id/code-storage`
- `GET /api/code-storage/repos`
- `GET /api/agents/:id/runs`
- `POST /api/agents/:id/runs`
- `GET /api/runs/:id`
- `GET /api/runs/:id/status`
- `POST /api/runs/:id/sandbox`
- `POST /api/runs/:id/exec`
- `POST /api/runs/:id/finalize`
- `POST /api/runs/:id/stop`
- `GET /api/heartbeats`
- `GET /api/heartbeats/:id`
- `POST /api/heartbeats`
- `GET /api/sandboxes`
- `GET /api/sandboxes/:id`
- `POST /api/agents/:id/sandboxes`
- `POST /api/sandboxes/stop-running`
- `POST /api/sandboxes/:id/exec`
- `POST /api/sandboxes/:id/bootstrap`
- `POST /api/sandboxes/:id/stop`
- `GET /api/messages`
- `GET /api/messages/listen`

CLI examples:

```bash
npm run cli -- health
npm run cli -- agents create --name research --repo https://github.com/org/repo.git --branch main
npm run cli -- runs plan --agent <agent_id> --objective "one bounded task"
npm run cli -- runs status <run_id>
npm run cli -- runs step --agent <agent_id> --objective "one bounded task" --bootstrap --finalize -- "pwd"
npm run cli -- runs sandbox <run_id> --bootstrap
npm run cli -- runs exec <run_id> -- "pwd"
npm run cli -- runs finalize <run_id> --message "Finalize run"
npm run cli -- runs stop <run_id>
npm run cli -- sandboxes start --agent <agent_id>
npm run cli -- sandboxes exec <sandbox_id> -- "pwd && ls -la"
npm run cli -- sandboxes stop-running --agent <agent_id>
npm run cli -- sandboxes stop <sandbox_id>
npm run cli -- messages listen --run <run_id>
```

## Modal Sandbox Status

Implemented:

- Dry-run provider for local testing.
- Live Modal provider via Modal JS SDK.
- `THREADBEAT_MODAL_MODE=live` switches to live mode.
- Live mode requires `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`.
- Live Modal sandbox starts a long-lived command, supports exec, and terminates on stop.
- `npm run smoke:modal` exists and starts a real Modal sandbox, runs `python --version`, and stops it when credentials are present.
- `npm run smoke:modal-cli` starts the server in live Modal mode and drives a real sandbox through `threadbeat-cli`.
- Modal live smoke passed with the repo-local `bafanas` credentials.

## Hosted Git / Code Storage Status

Code.Storage:

- Provider exists through `@pierre/storage`.
- Dry-run behavior exists when Code.Storage credentials are absent.
- Live smoke exists as `npm run smoke:code-storage`, but Code.Storage is not publicly accessible for the user right now.

GitHub hosted git:

- GitHub provider exists for private repo creation and clone URL generation.
- GitHub rate guard exists: conservative per-owner create limits.
- `npm run smoke:github` supports global `gh auth token` fallback.
- The user provided a GitHub token earlier and `gh` was logged in globally.
- Live GitHub smoke passed with real repo create/delete after token scope was fixed.
- Do not echo or reprint the token.

One old smoke repo may still exist from before delete scope was available:

```text
snbafana/threadbeat-live-smoke-moxtuwr7
```

It was likely created by an earlier failed cleanup run. If cleanup becomes relevant, verify it exists and delete only if it is clearly the old smoke repo.

## Recent Lifecycle Behavior

Run lifecycle:

- Planned runs start as `planned`.
- Starting/execing marks them `running`.
- Finalize marks them `completed` and stores `result_commit`.
- Failed operations mark them `failed`.
- `POST /api/runs/:id/stop` stops the associated sandbox, if present, and marks the run `stopped`.
- Stop refuses to rewrite already `completed` or `failed` runs.

Run sandbox behavior:

- `POST /api/runs/:id/sandbox` now reuses an existing running sandbox for the run and returns `existing: true`.
- If the run sandbox is already stopped or failed, `POST /api/runs/:id/sandbox` returns `409`.
- `POST /api/runs/:id/restart-sandbox` starts a fresh sandbox for a stopped or failed run sandbox and preserves the old sandbox record.
- This prevents accidental duplicate sandboxes for the same run.

Run status:

- `GET /api/runs/:id/status` returns the run, plan, sandboxes, and recent messages.
- CLI wraps it with `runs status <run_id> [--limit 20]`.

## Verification Status

The following passed after the latest committed slice:

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

`npm run smoke:modal` passes with real `bafanas` Modal credentials.

## Next Best Slices

Good next small durable slices:

1. Continue agent template phase:
   - Added `POST /api/agent-template` and `agents template --name <name> --out <dir>`.
   - The generated skeleton is Pi-native: `AGENTS.md`, `.pi/prompts`, `.pi/skills`, `.pi/extensions`, `state/`, `tasks/`, `findings/`, `artifacts/`, ignored `work/`.
   - Next: wire hosted Git repo creation plus an initial template commit so `agents create` can optionally create a fresh git-backed agent body instead of only registering an existing repo.

## Conceptual Decisions To Preserve

- Pi is runtime/bootloader, not agent identity.
- Agent identity should be the git-backed repo.
- Threadbeat server should orchestrate checkouts, sandboxes, branches, commits, status, and streams.
- Agent self-improvement should happen on run/self-edit branches with diff/eval/promotion, not direct mutation of active main.
- Prefer Pi-native repo resources later:
  - `AGENTS.md`
  - `.pi/settings.json`
  - `.pi/prompts/`
  - `.pi/skills/`
  - `.pi/extensions/`
- Avoid symlink-heavy durability models for now.
- Server Pi and sandbox Pi must remain separate use cases.

## Operational Notes

- Use small commits and push them.
- Continue running:

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

- Run `npm run smoke:modal` whenever Modal credentials may be present.
- Do not expose secrets in logs or final responses.
- Use the dry-run provider for local behavior tests when external credentials are missing.
