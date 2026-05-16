# Threadbeat Control Plane CLI Cleanup Plan

## Goal

Make Threadbeat usable as a durable CLI-driven control plane without requiring
operators to know every internal worker, replay, alert, and recovery route.
The default path must stay branch-native: runs finish by committing and pushing
result branches. Promotion and PR creation remain explicit follow-up actions.

## Command Surface Policy

### Canonical operator commands

These names are the public control-plane path. New docs, skills, smoke tests,
and command suggestions should prefer them.

- `runs cp-status`: cockpit status for what is running, what needs action, and
  what command would run next. Defaults to server-backed summary mode.
- `runs cp-next`: branch-native next action queue.
- `runs cp-operate`: bounded operator loop for action execution and recovery.
  Defaults to worker reconciliation and dry-run unless `--confirm` is supplied.
- `runs cp-workers`: worker inventory across core, mutation, review, operator,
  recovery, and replay workers. Defaults to retired-worker visibility.
- `runs cp-reconcile-workers`: recover dead, stopped, drifted, or restartable
  workers.
- `runs cp-results`: result inspection queue.
- `runs cp-branches`: branch-native run/result branches.
- `runs cp-timeline`: audit trail for ticks, advances, reconciliations,
  operator runs, branch recovery, and result review.

### Compatibility commands

The existing long `session-control-plane-*` and `session-*` commands remain
available while tests and docs move onto the canonical names. Do not delete one
until the equivalent `cp-*` path has smoke coverage and no generated command
queue depends on the old name.

### Internal/debug commands

Start/stop/restart commands for specific worker families, replay-loop internals,
alert detail commands, and raw terminal listings are implementation detail
surfaces. They can stay callable for tests and emergency recovery, but they
should not be the first path in docs or operator summaries.

## Execution Slices

1. Add canonical aliases without deleting compatibility routes.
2. Update docs, help text, and the repo-local skill to prefer canonical names.
3. Prove `cp-operate` recovers replay-loop and non-core
   workers, not only scoped status-watch recovery.
4. Add live Phase 4/5 verification around one command that creates a run branch,
   starts Modal, clones the repo, writes the task file, runs Pi or the fixed
   command, commits, pushes, and stops.
5. Add crash/restart tests for longer multi-agent sessions: workers die,
   process restarts, branch state survives, and recovery resumes without
   duplicate commits.
6. Decommission or hide old CLI names only after command suggestions and smoke
   tests use canonical names.

## Current Known Gaps

- `runs work --check-runtime --finalize` still needs stricter failure flow so a
  failed runtime check cannot be masked by a later finalize.
- Stale dry-run loop records can keep status noisy after confirmed result review
  has already cleared the pending result commits.
- Full autonomous Modal + Pi branch result flow needs longer live soak testing
  across process restart and worker recovery.
