# Sandbox Agent Runtime Plan

This branch changes the v0.5 direction from a narrow task table refactor into a
local-first sandbox control plane. The goal is to make the core objects explicit
before adding Modal or any multi-agent deployment layer.

## Implementation Goal

Threadbeat should become a control plane that can create, wake, stream, stop,
and audit durable agents that work inside versioned sandboxes.

The control plane owns truth:

- agent registry
- sandbox registry
- task/goal queue
- run history
- event stream
- tool-call ledger
- file/git history metadata

Runtime providers own temporary execution:

- current hosted shared Pi session
- future local sandbox worker
- future Modal sandbox worker

## Core Objects

### Agent

A durable identity and state owner. It can be offline while still retaining its
sandbox, skills, wakeup policy, and history.

Initial fields:

- `id`
- `name`
- `purpose`
- `status`
- `runtime_provider`
- `default_memory_mode`
- `sandbox_id`
- `skills`
- `wakeup_policy`
- `notification_policy`
- `created_at`
- `updated_at`

### Sandbox

A durable filesystem and git/version boundary for one agent or task. The first
provider should be local filesystem/git worktree, not Modal.

Initial fields:

- `id`
- `agent_id`
- `provider`
- `mount_path`
- `repo_url`
- `branch`
- `current_commit`
- `state`
- `created_at`
- `updated_at`

Expected filesystem shape:

```text
state.md
task.md
findings/
data/
artifacts/
logs/
skills/
.agent/
  manifest.json
  decisions.jsonl
  tool_calls.jsonl
  run_log.jsonl
```

### Task / Goal

A bounded work order assigned to an agent. Heartbeats, pokes, webhooks, or an
orchestrator can create tasks.

Initial fields:

- `id`
- `agent_id`
- `created_by`
- `type`
- `objective`
- `status`
- `priority`
- `input_event_id`
- `failure_policy`
- `result_summary`
- `created_at`
- `updated_at`

### Run

One execution attempt for a task.

Initial fields:

- `id`
- `task_id`
- `agent_id`
- `runtime_provider`
- `sandbox_id`
- `runtime_instance_id`
- `status`
- `started_at`
- `completed_at`
- `exit_reason`
- `input_snapshot`
- `output_summary`
- `commit_before`
- `commit_after`

### Event

The append-only truth layer for agents, sandboxes, tasks, runs, tool calls,
files, git commits, and message deltas.

Initial event families:

- `agent_*`
- `sandbox_*`
- `task_*`
- `run_*`
- `tool_call_*`
- `file_*`
- `git_*`
- `agent_message_*`
- `notification_*`

## First Local Slice

The first implementation should be additive and local-only:

1. Add schema for `agents`, `sandboxes`, `agent_tasks`, `agent_runs`, and
   `agent_events`.
2. Add typed DB helpers for create/list/get plus basic state transitions.
3. Add a local sandbox initializer that creates the expected directory shape
   under an ignored runtime directory.
4. Add read-only API/CLI inspection for agents, sandboxes, tasks, runs, and
   events.
5. Keep existing hosted heartbeat behavior untouched until the new objects have
   tests and inspection paths.

## Non-Goals For This Branch Stage

- No Modal deployment yet.
- No arbitrary write API exposed to users.
- No multi-agent scheduler.
- No migration of hosted heartbeat execution until local objects are proven.
- No durable interactive message log unless explicitly requested.

## Acceptance Check

The branch is ready to merge its first slice when a local test can:

1. create an agent,
2. create a local sandbox for it,
3. create a task,
4. create a run with commit metadata fields,
5. append events for each state transition,
6. list the full chain through API or DB helpers,
7. leave the existing hosted heartbeat tests unchanged.
