# Agent Control Plane Architecture Brainstorm

This note sketches how Threadbeat could evolve from a hosted heartbeat loop into
a control plane for creating, waking, streaming, stopping, and auditing
sandboxed agents.

The key correction: the current Fastify API should not become "the agent." It
should become the control plane. Agents should be durable identities with
stateful sandboxes, while compute processes can be started and stopped around
those identities.

## Target Shape

```text
User terminal / TUI / API client
  -> Fastify control plane
      -> auth / routing / policy
      -> agent registry
      -> task queue
      -> event stream
      -> sandbox manager
      -> git/version manager
      -> tool-call ledger
  -> Runtime providers
      -> hosted shared Pi session
      -> Modal sandbox workers
      -> local device workers
      -> future browser/desktop workers
  -> Durable state
      -> Turso/Postgres control DB
      -> sandbox filesystem volumes
      -> git remotes per sandbox or per agent
      -> object storage for artifacts/logs
```

The control plane owns truth. Runtime providers own temporary execution.

## Core Objects

### Agent

An agent is a durable identity, not a process.

Fields:

- `id`
- `name`
- `purpose`
- `status`: active, paused, archived
- `runtime_provider`: hosted, modal, local_device
- `default_memory_mode`: shared, per_agent, stateless
- `sandbox_id`
- `repo_url`
- `current_ref`
- `skills`
- `wakeup_policy`
- `notification_policy`
- `created_at`, `updated_at`

An agent can be offline and still exist. Starting the agent means provisioning a
runtime against its durable state.

### Sandbox

A sandbox is the durable filesystem and version history attached to an agent or
task.

Fields:

- `id`
- `agent_id`
- `provider`: modal_volume, local_path, git_worktree, docker_volume
- `mount_path`
- `repo_url`
- `branch`
- `current_commit`
- `base_image`
- `state`: ready, provisioning, running, stopped, broken

The sandbox should contain:

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

### Task

A task is bounded work assigned to an agent.

Fields:

- `id`
- `agent_id`
- `created_by`: user, heartbeat, orchestrator, external_event
- `type`: research, code, monitor, summarize, verify, maintain
- `objective`
- `status`: queued, claimed, running, waiting, succeeded, failed, cancelled
- `priority`
- `input_event_id`
- `started_at`, `completed_at`
- `failure_policy`
- `result_summary`

Tasks should be the bridge between heartbeats and execution. A heartbeat should
create or wake tasks; workers should claim tasks.

### Run

A run is one execution attempt for a task.

Fields:

- `id`
- `task_id`
- `agent_id`
- `runtime_provider`
- `sandbox_id`
- `runtime_instance_id`
- `status`
- `started_at`, `completed_at`
- `exit_reason`
- `input_snapshot`
- `output_summary`
- `commit_before`
- `commit_after`

Runs let the system answer: "what happened this time?"

### Event

Events are the append-only truth layer.

Event types:

- `agent_created`
- `agent_poked`
- `agent_started`
- `agent_stopped`
- `task_queued`
- `task_claimed`
- `run_started`
- `tool_call_started`
- `tool_call_delta`
- `tool_call_finished`
- `file_changed`
- `git_commit_created`
- `agent_message_delta`
- `agent_message_done`
- `notification_proposed`
- `notification_sent`
- `run_failed`
- `run_succeeded`

The event log should be enough to inspect the system without reading process
logs.

## Control Plane API

The API should stay boring and typed.

### Agents

```text
POST   /api/agents
GET    /api/agents
GET    /api/agents/:id
PATCH  /api/agents/:id
POST   /api/agents/:id/poke
POST   /api/agents/:id/start
POST   /api/agents/:id/stop
POST   /api/agents/:id/reset
GET    /api/agents/:id/status
GET    /api/agents/:id/events
GET    /api/agents/:id/stream
```

`poke` is the universal input primitive. A poke can be a user message, a
heartbeat, a webhook, an email event, a file-change event, or an orchestrator
instruction.

### Tasks

```text
POST   /api/tasks
GET    /api/tasks
GET    /api/tasks/:id
PATCH  /api/tasks/:id
POST   /api/tasks/:id/cancel
POST   /api/tasks/:id/retry
GET    /api/tasks/:id/runs
GET    /api/tasks/:id/stream
```

The current heartbeat executor should eventually create tasks instead of
calling Pi directly.

### Sandboxes

```text
POST   /api/sandboxes
GET    /api/sandboxes/:id
POST   /api/sandboxes/:id/start
POST   /api/sandboxes/:id/stop
POST   /api/sandboxes/:id/commit
POST   /api/sandboxes/:id/checkout
GET    /api/sandboxes/:id/files
GET    /api/sandboxes/:id/files/*path
GET    /api/sandboxes/:id/git/log
GET    /api/sandboxes/:id/git/diff
GET    /api/sandboxes/:id/artifacts
```

The control plane should not expose arbitrary write endpoints until sandbox
isolation and authorization are clear. Writes should happen through worker
tool calls and be recorded in the event/tool ledger.

### Streams

```text
GET /api/agents/:id/stream
GET /api/tasks/:id/stream
GET /api/runs/:id/stream
GET /api/events/stream?agentId=...
```

Streams should be Server-Sent Events or NDJSON first. WebSockets can come later
if bidirectional transport matters. For terminal usage, NDJSON is simpler and
easier to pipe.

The stream should multiplex:

- Agent message deltas.
- Tool-call starts/deltas/results.
- File changes.
- Git commits.
- Task status changes.
- Notification decisions.

## Agent Lifecycle

### Create

```text
POST /api/agents
  -> insert agent row
  -> provision sandbox row
  -> create git branch/repo if needed
  -> write initial state.md/task.md
  -> commit initial sandbox state
  -> emit agent_created
```

### Poke

```text
POST /api/agents/:id/poke
  -> write input event
  -> route to orchestrator policy
  -> either enqueue task, wake existing runtime, or store for later
  -> stream acknowledgement
```

Poke should not necessarily start compute. The orchestrator decides whether the
input requires a runtime wakeup.

### Start

```text
POST /api/agents/:id/start
  -> acquire agent lock
  -> resolve sandbox commit/ref
  -> start runtime provider
  -> mount/check out sandbox
  -> inject scoped env
  -> emit agent_started
```

Start should be idempotent. If an agent is already running, return the current
runtime instance.

### Run Task

```text
worker claims task
  -> emits task_claimed
  -> starts run
  -> reads sandbox state
  -> streams model/tool events
  -> writes files/artifacts
  -> commits sandbox changes
  -> updates task terminal state
  -> emits run_succeeded or run_failed
```

The key invariant: if files changed, the run should either commit them or mark
them as discarded with an explicit event.

### Stop

```text
POST /api/agents/:id/stop
  -> request graceful stop
  -> wait for current tool/model call boundary
  -> flush event buffer
  -> commit or discard dirty sandbox state by policy
  -> stop runtime
  -> emit agent_stopped
```

Stop should not delete the durable agent, sandbox, or git history.

## Runtime Providers

### Hosted Shared Pi

This is the current v0.4 runtime.

Properties:

- Single server-side Pi session.
- Process-local memory.
- Good for one hosted singular agent.
- Not isolated enough for arbitrary write tools.
- Useful as a control-plane bootstrap runtime.

### Modal Sandbox Runtime

This is the likely first real sandbox runtime.

Properties:

- One Modal Volume per agent or sandbox.
- Worker image includes Node, Pi SDK/runtime wrapper, git, and approved tools.
- Control plane sends task specs and receives event streams.
- Worker commits filesystem changes before shutdown.
- Environment variables are scoped per task/agent.

Open design choice: whether each task gets a fresh container with the same
volume, or whether some agents maintain a warm container for faster iteration.

### Local Device Runtime

This should come later.

Properties:

- Device daemon registers capabilities.
- Control plane can assign local-only tasks.
- Stronger user approval requirements for writes, browser/desktop actions, and
  credential access.

## Streaming Model

The user should be able to subscribe to a specific agent, task, or run.

For example:

```bash
threadbeat agents stream ag_sports_research
threadbeat tasks stream task_123
threadbeat runs stream run_456
```

The event stream should include typed envelopes:

```json
{
  "type": "tool_call_started",
  "agent_id": "ag_...",
  "task_id": "task_...",
  "run_id": "run_...",
  "tool": "web_fetch",
  "created_at": "..."
}
```

```json
{
  "type": "agent_message_delta",
  "agent_id": "ag_...",
  "run_id": "run_...",
  "delta": "found a new source cluster..."
}
```

Terminal clients can render this as:

```text
[agent:sports] thinking...
[tool:web_fetch] https://...
[file] findings/source-map.md updated
[git] commit abc123 scout: add source cluster
[agent:sports] new lead: ...
```

## Tool Calls

Tool calls need to be first-class records.

Tool call fields:

- `id`
- `agent_id`
- `task_id`
- `run_id`
- `tool_name`
- `input_json`
- `status`
- `started_at`
- `completed_at`
- `output_json`
- `error`
- `risk_level`
- `approval_required`
- `sandbox_commit_before`
- `sandbox_commit_after`

Tool policy should separate read and write:

- Read tools can usually run automatically inside a sandbox.
- Write tools can mutate only the sandbox by default.
- External writes need explicit policy or approval.
- Shell/bash is a write-capable tool if it can touch filesystem, network, git,
  package managers, or external services.

The safest default: all worker tools run inside sandbox boundaries, and only
the control plane can promote artifacts or commits out of the sandbox.

## Git History and Filesystems

Every sandbox should have git turned on from the start.

Recommended branch pattern:

```text
agents/<agent-slug>/main
agents/<agent-slug>/runs/<run-id>
tasks/<task-id>
```

Commit policy:

- Commit initial agent state on creation.
- Commit after each successful run.
- Commit after meaningful intermediate checkpoints for long runs.
- Commit failed-run debug state if it helps explain failure.
- Never silently discard dirty state.

Commit message pattern:

```text
<actor>: <verb phrase>

agent: ag_...
task: task_...
run: run_...
reason: ...
```

The control plane should expose:

- Current files.
- File diffs.
- Commit log.
- Run-to-commit mapping.
- Commit-to-event mapping.
- Checkout by task/run/commit.

This gives the user a way to inspect the agent's mind in reverse.

## State Model

There are three state layers:

1. Control DB state.
2. Sandbox filesystem state.
3. Runtime memory state.

The DB is canonical for scheduling and lifecycle. The sandbox is canonical for
artifacts, notes, source graphs, and persistent working memory. Runtime memory
is useful but disposable.

If a runtime dies, the agent should be resumable from:

- latest DB task/event state
- latest sandbox commit
- latest `state.md`
- latest checkpoint summary

## Orchestrator Loop

The orchestrator is a normal agent with special permissions over lifecycle.

Loop:

```text
read global state
read recent events
score agents/tasks for attention
decide: continue, wake, pause, stop, summarize, notify, spawn
write decision event
execute lifecycle actions
commit any changed orchestrator state
```

The orchestrator should not own all cognition. It should own routing and
state-transition decisions.

## Open Decisions

- Should each persistent agent get a separate git remote, or should all agent
  branches live in one monorepo?
- Should the first sandbox provider be Modal Volume, local Docker, or local
  git worktrees?
- Should streams be NDJSON forever, or should there be a WebSocket layer once
  the terminal control plane stabilizes?
- Should tool-call approvals be synchronous user prompts or asynchronous
  policy rows?
- Should personal-data modules live as skills, model adapters, retrieved
  profile memory, or separate proposal agents?
- Should agent state be mostly markdown files, structured JSON, SQLite inside
  the sandbox, or all three?

## MVP Sequence

1. Add `agents`, `tasks`, `task_events`, `runs`, `sandboxes`, and
   `tool_calls` tables.
2. Keep the current hosted shared Pi session as `runtime_provider=hosted`.
3. Change heartbeats to create tasks instead of directly calling Pi.
4. Add task claiming/execution through the existing runtime.
5. Add `/api/agents/:id/stream` and `/api/tasks/:id/stream` as filtered views
   over the event log plus live process-local deltas.
6. Add a local filesystem sandbox provider first, only for trusted development.
7. Add git initialization and commit-after-run.
8. Add Modal Volume runtime once the task/event/sandbox contract is stable.
9. Add orchestrator policies for wake/stop/notify.
10. Add skill promotion from repeated successful sandbox histories.

The reason to do it in this order: task/event/sandbox contracts are the stable
core. Modal, local device workers, and richer TUIs are replaceable runtimes and
interfaces on top.
