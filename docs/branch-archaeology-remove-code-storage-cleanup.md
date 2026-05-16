# Branch Archaeology: `codex/remove-code-storage-cleanup`

Date: 2026-05-16

This note preserves the context from the oversized cleanup branch before moving
implementation work back to a clean branch.

## Branch Position

- Current branch audited: `codex/remove-code-storage-cleanup`
- Base branch used by PR: `sandbox-agent-runtime`
- Merge base: `3d98eb02645a64184af3783a1cda913ba32123d5`
- Head during audit: `dd0f17e8 Fix sandbox runtime model check`
- Diff against `origin/sandbox-agent-runtime`: 78 files, 71,918 insertions,
  2,937 deletions
- Diff against `origin/main`: 137 files, 87,183 insertions, 6,909 deletions

The PR title says "Remove Code.Storage backend paths", but the branch contains
601 commits after `sandbox-agent-runtime`. The first cleanup commit was small
and reasonable:

- `5f7c5465 Remove Code Storage backend`: 117 insertions, 721 deletions

Most of the later branch grew into a separate control-plane/operator project.

## Intended Product Direction

The coherent core direction is still the one described in
`docs/modal-control-plane-plan.md`:

- GitHub repository is the durable agent body.
- Modal sandbox is disposable compute.
- Each run creates or uses a Git branch.
- Sandbox bootstrap clones the agent repository into `/workspace/agent`.
- Pi runs inside that checkout.
- Threadbeat commits and pushes the run result branch.
- Promotion or PR creation remains explicit and separate.

That core is valuable and should be implemented on a clean branch from
`sandbox-agent-runtime`.

## What The Branch Added

The branch starts with Code.Storage removal, then adds a very large local
operator stack:

- Multi-agent run queueing, dispatch, and supervision.
- Detached local worker sessions recorded under `.threadbeat/worker-sessions`.
- Branch-native result review and stopped-branch resume queues.
- Apply ledgers for executing generated command queues.
- Drain continuation records and detached drain workers.
- Session watch workers and apply-action workers.
- Control-plane ticks, advances, alerts, timelines, and confirmation queues.
- Worker reconciliation across many worker families.
- Saved control-plane worker bundles.
- Operator loops, result-review loops, recover-next loops, deferred loops.
- Terminal overview and terminal replay-loop machinery.
- Large smoke tests that assert exact generated command strings.

## Main Structural Problem

The branch split durable state across too many layers:

- SQLite stores agents, runs, sandboxes, hosted Git records, heartbeats, and
  messages.
- GitHub stores the actual agent repositories and run branches.
- Modal stores disposable sandbox execution.
- `.threadbeat/worker-sessions/**` stores local JSON process records,
  command ledgers, recovery attempts, tick records, and replay state.
- The CLI emits runnable command arrays that become part of the API contract.
- Tests assert exact command strings, which freezes the accidental command
  surface.

This makes the control plane self-referential: the server emits CLI commands,
the CLI calls the server, workers spawn the CLI, durable ledgers store CLI
commands, and tests assert those command strings.

## Largest Hotspots

- `scripts/threadbeat-cli.ts`: about 29k lines. The `runs()` function alone is
  almost 10k lines and acts as router, API client, operator, formatter, worker
  supervisor, and command generator.
- `src/server.ts`: about 8k lines. `buildServer()` is over 3k lines before the
  helper section, and routes contain substantial business logic.
- `scripts/smoke.ts`: about 8k lines, mostly narrative end-to-end assertions.
- `scripts/detached-session-smoke.ts`: about 6k lines.
- Control-plane smoke files add thousands more exact command assertions.

## What To Carry Forward

Carry these ideas into a clean branch:

- Code.Storage removal, but reapply it directly and narrowly.
- GitHub-only hosted Git provider.
- Agent template creation.
- Run planning and branch naming.
- Sandbox bootstrap into `/workspace/agent`.
- Runtime check for Pi inside the sandbox.
- Boot command that writes a bounded task and invokes Pi.
- Finalize command that commits and pushes the run branch.
- Minimal CLI path:
  - `agents init`
  - `runs plan`
  - `runs step`
  - `runs boot`
  - `runs finalize`
  - `runs inspect-result`
  - `sandboxes stop-running`

## What Not To Carry Forward

Do not port these into the clean implementation:

- Detached worker sessions.
- Local `.threadbeat/worker-sessions` JSON as the main control-plane ledger.
- Generated command queues as API payload contracts.
- Apply ledgers and drain continuations.
- Control-plane ticks, advances, alerts, timelines, and confirmation drains.
- Worker bundles and generic worker reconciliation.
- Terminal overview and replay loops.
- Massive README command catalog.
- Smoke tests that assert exact long command strings.

## Clean Branch Recommendation

Start from `origin/sandbox-agent-runtime`. Rebuild one thin path first:

1. Remove Code.Storage references.
2. Keep the server API small and stateful only where necessary.
3. Keep the CLI as a thin client over the API.
4. Prove one local dry-run path.
5. Prove one live Modal/GitHub/Pi path.
6. Add recovery only after a specific real failure mode is observed.

The clean branch should treat multi-agent scheduling as a future product model,
not as an implicit local process graph hidden behind CLI command queues.
