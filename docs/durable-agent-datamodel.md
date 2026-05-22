# Threadbeat Spec v1
Threadbeat is a persistent control plane for spinning up and interacting with long-running agents.

In this primitive, an agent is a git repo with a startup script. That is the north star. Threadbeat should make that repo-backed agent durable, inspectable, resumable, and improvable without hiding it behind a heavyweight agent framework.

The important loop is agent-ception: agents can improve agents by reading traces of runs, failures, outputs, and human feedback, then opening changes against the agent repo. GitHub stores the agent implementation and its version history. Traces, outputs, screenshots, browser recordings, and other high-fidelity run data live outside the repo.
## V1 Opinion
Threadbeat should be opinionated in V1:

1. An agent runs in a single sandbox to make progress on a single thread.
  
2. A thread has a north-star goal, but the goal can be revised as the human adds context.
  
3. One thread has one active sandbox.
  
4. When the agent finishes a step, the sandbox should not close immediately. It should enter an idle window so a human can inspect it, message it, or continue it.
  
5. When the idle window expires, or at configured cleanup times, Threadbeat should close the sandbox and keep durable state on the thread.
  
6. If the human continues later, Threadbeat starts or attaches a sandbox for the same thread and replaces the thread's sandbox ID.
  
7. Long-term continuity should come from durable state and memory distillation, not from keeping sandboxes alive forever.
  
8. Agent improvement should happen by reading run evidence and editing the agent repo, not by stuffing all traces into GitHub.
  

This means Threadbeat is not trying to keep an immortal agent process alive. It is trying to make repeated sandboxed attempts feel like one durable working relationship.
## Storage Split
Threadbeat should keep three stores conceptually separate:

- SQL: control-plane state, schedules, statuses, relationships, compact summaries.
  
- Object storage: traces, outputs, screenshots, fetched files, run bundles.
  
- GitHub: agent code, prompts, tools, tests, and updater PRs.
  

The repo is for the agent itself. The run substrate belongs in object storage. SQL ties the two together.
## Core Objects
### Agent
An agent is a versioned implementation identity.

For V1, it is a GitHub repo with a unified startup script, such as `threadbeat-agent.sh` or `threadbeat-agent.mjs`.

Fields:

- `id`
  
- `name`
  
- `repo_url`
  
- `version`
  

`version` should identify the branch or commit used for a thread execution. The agent implementation evolves through GitHub. Run traces and outputs should not be committed back into the agent repo except when they become fixtures, tests, or documentation.

An agent is not a live process. It is not a sandbox. It is not the thread.
### Thread
A thread is the durable human-facing continuity object and the V1 execution owner.

When a human says "send this agent to work on this problem," Threadbeat creates a thread. That thread names the problem, stores the current working state, and collects messages, events, artifacts, and exactly one current sandbox row if a sandbox is attached.

The thread should have a north-star goal, but the goal is allowed to move. This matters for research and exploration, where the human may learn what they actually want only after the first agent attempt returns.

Fields:

- `id`
  
- `title`
  
- `status`
  
- `agent_id`
  
- `goal (json)`
  
- `created_at`
  
- `updated_at`
  

Thread status should start small:

- `queued`: created but not yet running.
  
- `running`: the sandbox is actively executing the agent.
  
- `idle`: the agent has yielded or completed a step, and the sandbox is being kept warm for human follow-up.
  
- `paused`: no work should be started automatically.
  
- `completed`: the thread goal is done enough for now.
  
- `failed`: the latest execution failed and needs human or updater attention.
  
- `archived`: hidden from active work.
  
### Sandbox
A sandbox is the operational runtime attached to a thread.

V1 should allow many sandbox rows over a thread's lifetime, but only one current sandbox should be used at a time. The newest sandbox is determined by `index`. This gives thread-level sandbox history without adding a public `runs` table.

Fields:

- `id`
  
- `thread_id`
  
- `provider`
  
- `external_id`
  
- `idle_expires_at`
  
- `created_at`
  
- `updated_at`
  
- `closed_at`
  
- `index`
  

Do not store sandbox status in V1. Daytona or the active provider is the source of truth for whether the sandbox is running, stopped, deleted, or unreachable. Threadbeat should cache only what it needs to decide cleanup and resume behavior.

Use a unique constraint on `(thread_id, index)`. To find the current sandbox:

```sql
select *
from sandboxes
where thread_id = $1
order by index desc
limit 1;
```

If the provider says the latest sandbox is gone or unreachable, create a new sandbox row with the next index and hydrate from thread state.
### Message
A message is the human-facing interaction log.

Messages are how humans, agents, heartbeats, and verifier/updater agents interact with a thread.

Fields:

- `id`
  
- `thread_id`
  
- `role`
  
- `content_json`
  
- `created_at`
  

Roles:

- `human`
  
- `agent`
  
- `heartbeat`
  

Use `content_json` only. Do not split message payload into text plus JSON in V1. Simple human text can be represented as:

```json
{ "text": "keep going, focus on county-level sources" }
```

Structured messages can add fields without a schema migration:

```json
{
  "text": "continue this thread",
  "artifact_ids": ["artifact_123"],
  "mode": "research"
}
```

Tool-call internals do not need to be messages in V1. They belong in events and trace artifacts. A message is for interaction and continuity.
### Event
An event is thread execution telemetry.

Events are ordered facts emitted while an agent is executing inside the current sandbox row:

- `thread.started`
  
- `sandbox.created`
  
- `agent.started`
  
- `tool.started`
  
- `tool.completed`
  
- `command.stdout`
  
- `artifact.created`
  
- `thread.idle`
  
- `thread.completed`
  
- `thread.failed`
  

Fields:

- `id`
  
- `thread_id`
  
- `seq`
  
- `type`
  
- `source`
  
- `data_json`
  
- `created_at`
  

Keep `source`. It answers "who emitted this event?" without forcing that detail into every event payload. Useful values are `worker`, `sandbox`, `agent`, `tool:<name>`, `heartbeat:<id>`, and `verifier`. If it proves redundant later, it can be flattened into `data_json`, but it is cheap and useful for debugging.

Events should be compact enough to query and stream. Large payloads should be stored as artifacts and referenced from the event.
### Artifact
An artifact is a durable pointer to run evidence in object storage.

Artifacts are core because they are how updater agents learn from what happened without bloating SQL or GitHub.

Fields:

- `id`
  
- `thread_id`
  
- `kind`
  
- `uri`
  
- `content_type`
  
- `sha256`
  
- `size_bytes`
  
- `summary_json`
  
- `created_at`
  

Examples:

- trace JSONL
  
- tool-call transcript
  
- stdout/stderr bundle
  
- screenshots
  
- browser recording
  
- HAR file
  
- downloaded source document
  
- extracted text
  
- final report
  
### Heartbeat
A heartbeat is scheduled message injection.

It does not create a parallel runtime. It appends a message to a thread. If the thread is idle or has no sandbox, the worker can start or resume sandboxed execution for that thread.

Fields:

- `id`
  
- `thread_id`
  
- `status`
  
- `cadence_seconds`
  
- `message_json`
  
- `next_tick_at`
  
- `last_tick_at`
  
- `created_at`
  
- `updated_at`
  

Heartbeat status:

- `active`
  
- `paused`
  
- `disabled`
  

V1 rule: heartbeats are attached to threads, not raw sandboxes. A heartbeat should not assume the previous sandbox still exists.
## Multi-Agent Delegation
V1 should not model multi-agent coordination as multiple agents inside one thread sandbox.

If an agent in a sandbox wants to delegate, the cleaner path is for it to call the Threadbeat control plane API and create or message another thread. That keeps the control plane/sandbox boundary clean:

```text
agent in sandbox A
  -> calls Threadbeat API
  -> creates/messages thread B
  -> worker starts sandbox B
```

This gives multi-agent delegation without making one sandbox own many agents or making one thread have multiple active sandboxes. Large-scale coordination can then be built out of many threads with parent/child links later.

For V1, keep the invariant:

```text
one thread -> one current agent -> at most one active sandbox
```

Do not put multiple agents in the same sandbox unless there is a concrete full-fidelity smoke showing it is necessary.
## Pressure Test
### Human Continues During Idle Window
Case: the agent finishes a step, returns a partial answer, and the human sends a follow-up within six hours.

The model holds. The thread is `idle`, the latest sandbox row has not expired, and the provider reports the sandbox is reachable. Threadbeat appends a `human` message with JSON payload, flips the thread back to `running`, and resumes the same sandbox.

Required invariant:

```text
thread.status = idle
provider_status = running-or-idle
now < sandbox.idle_expires_at
```

If the provider reports the sandbox is reachable, reuse it. If the provider reports it is gone or unreachable, create a new sandbox row with the next index and hydrate from durable state.
### Human Continues After Cleanup
Case: the agent finished yesterday, the sandbox was closed, and the human now asks a follow-up.

The model holds. The thread still owns messages, state, summary, events, and artifacts. Threadbeat appends the new message, starts a fresh sandbox, creates a new sandbox row with the next index, and hydrates the agent from durable state.

This is the main reason the thread, not the sandbox, owns continuity.
### Agent Delegates To Another Agent
Case: agent A is running in sandbox A and wants another agent to inspect a subproblem.

The model mostly holds if delegation happens through the control plane:

```text
agent A -> Threadbeat API -> create child thread -> worker starts sandbox B
```

This avoids violating the V1 invariant that one thread has at most one active sandbox. The missing field is a parent/child relationship. Add only when needed:

- `parent_thread_id`
  
- `created_by_thread_id`
  
- `created_by_message_id`
  

Do not add multi-agent-in-one-sandbox as the first coordination primitive.
### Multiple Humans Message The Same Thread
Case: two humans send messages while the agent is running.

The model needs a queueing rule. Messages can append immediately, but execution must stay single-flight:

```text
messages append in order
thread has one active sandbox execution
agent consumes new messages when it polls or when the control plane injects them
```

If live injection is hard, V1 can require that new messages wait until the agent yields. The thread remains the ordering boundary.
### Heartbeat Fires While Running
Case: a heartbeat fires while the thread is already `running`.

The model holds if the heartbeat only appends a message and does not start a second sandbox. The active agent may see the message immediately if live injection exists, or on the next yield/resume if not.

Rule:

```text
heartbeat can append message
heartbeat cannot create a second active sandbox for the same thread
```
### Heartbeat Fires While Idle
Case: heartbeat fires while the sandbox is warm and idle.

The model holds. Append the heartbeat message, mark the thread `running`, and resume the warm sandbox.

If the latest sandbox row is past its idle window, close it through the provider, set `closed_at`, then start a fresh sandbox row with the next index.
### Agent Crashes Mid-Execution
Case: the sandbox process crashes before writing a final checkpoint.

The model holds if events and artifacts are written incrementally. Mark `thread.status = failed`, write failure events, and rely on the provider plus `closed_at` for sandbox lifecycle truth.

Then preserve whatever exists:

- messages so far;
  
- event stream;
  
- partial trace artifact;
  
- stdout/stderr artifact;
  
- last summary/state snapshot.
  

The retry path starts a new sandbox on the same thread.
### Artifact Upload Fails
Case: the agent completes but trace upload to object storage fails.

The model needs a degraded state. Do not mark the thread fully clean if the run evidence is missing. Options:

- create an `artifact.created` event only after upload succeeds;
  
- keep an `artifact_upload_failed` event type;
  
- mark `thread.status = failed` if the missing artifact is required for replay.
  

For V1, trace upload should be required for successful completion.
### Agent Version Changes Between Messages
Case: the updater improves the agent repo after a bad run, and the human resumes the same thread with the new agent version.

The model holds because `thread.current_agent_id` and `agent_version` identify what should run next. Events and artifacts should record the version used at the time they were produced, either in `data_json` or artifact metadata.

If exact version history becomes important, add an `agent_version` field to each artifact and event payload before adding another table.
### Thread Goal Changes
Case: the human changes the goal after early exploration.

The model holds for V1. Update `goal_text`, append a human message explaining the change, and preserve the previous goal in message history or `state_json`.

Do not add a goals table until goal history needs first-class querying.
### Control Plane API From Sandbox
Case: agents are allowed to call Threadbeat APIs from inside sandboxes.

This is powerful and dangerous. It is probably the right delegation primitive, but it requires scoped credentials:

- agent can create child threads;
  
- agent can append messages to threads it created or was granted;
  
- agent cannot mutate arbitrary agents, delete artifacts, or read unrelated threads by default;
  
- updater agents get a different permission set from research agents.
  

This is an auth model problem, not a reason to merge control plane and sandbox implementation.
### Does Removing Runs And Tasks Hurt Replay?
Removing `runs` and `tasks` as first-class tables makes V1 simpler, but the system still needs execution-attempt boundaries for debugging. The pressure point is:

```text
How do we group events/artifacts from one sandbox execution?
```

Options:

1. Add `execution_id` as a lightweight string on events/artifacts, without making it a public product object.
  
2. Put attempt boundaries only in artifact metadata.
  

Recommendation: do not keep `tasks`, even internally, in V1. Publicly and internally, the control plane should think in threads, messages, sandbox rows, events, and artifacts. Add `execution_id` later only if thread events and artifact metadata cannot explain execution attempts well enough.
### Strongest Current Shape
The current V1 model survives if these invariants are enforced:

1. Thread is the durable continuity object.
  
2. Thread owns durable continuity; sandbox lifecycle lives in many sandbox rows ordered by `index`.
  
3. At most one current provider-reachable sandbox should be used per thread.
  
4. Messages are append-only JSON payloads.
  
5. Events are compact execution telemetry.
  
6. Artifacts are required for high-fidelity run evidence.
  
7. Heartbeats append messages and never create parallel execution.
  
8. Multi-agent delegation creates or messages other threads through the control plane.
  
9. Messages start or resume work; tasks do not exist as a V1 primitive.
  
## Lifecycle
### Start A Thread
```text
human chooses agent + sends message
  -> create thread
  -> append human message
  -> infer or update goal_json from the message set
  -> create sandbox
  -> create a sandbox row for the thread with the next index
  -> clone the agent repo
  -> materialize thread context
  -> execute agent startup script
```
### Agent Yields Or Finishes A Step
```text
agent runs
  -> events stream into SQL
  -> traces/artifacts upload to object storage
  -> agent/checkpoint message is appended
  -> thread state and summary are updated
  -> thread becomes idle
  -> latest sandbox row stays warm until sandbox.idle_expires_at
```
### Cleanup
```text
idle window expires or cleanup time arrives
  -> close sandbox
  -> set closed_at on the sandbox row
  -> keep messages, state, summary, events, and artifacts
```
### Continue Later
```text
human sends another message or heartbeat fires
  -> append message to same thread
  -> infer or update goal_json from the message set
  -> if sandbox is warm, continue in that sandbox
  -> otherwise start a new sandbox row with the next index
  -> hydrate agent from thread messages, state, summaries, and artifacts
```
### Improve The Agent
```text
updater reads failed or low-quality run evidence
  -> pulls traces/artifacts from object storage
  -> opens the agent GitHub repo
  -> edits prompts/tools/tests/startup behavior
  -> opens a PR
  -> records the updater action back on the thread
```
## What V1 Is Not
V1 should not support:

- multiple active sandboxes for the same thread;
  
- multiple agents inside one sandbox;
  
- immortal sandboxes as the source of memory;
  
- a separate goals table;
  
- a separate runs table;
  
- a separate tasks table;
  
- a separate scheduler runtime;
  
- committing every run trace to GitHub;
  
- broad multi-agent orchestration before a single repo-backed agent works well.
  

These can come later if the simple model fails.
## Minimal Implementation Shape
The smallest useful implementation should converge toward:

1. `agents`
  
2. `threads`
  
3. `messages`
  
4. `events`
  
5. `artifacts`
  
6. `heartbeats`
  
Do not add public or private `tasks` in V1. A message is the unit of interaction, a thread is the unit of continuity, a sandbox row is the runtime attachment, and events/artifacts carry execution evidence.
## Open Questions
1. What should the first goal-inference prompt/schema return from an ordered set of messages?
  
2. What is the minimal object-storage interface: upload JSONL traces first, or generic artifact pointers first?
  
3. What exactly should the agent receive on startup: full message history, distilled summary, artifact manifest, or all three?
  
4. Should the final checkpoint message be required by the harness, or left to the agent implementation?
  
5. How should updater-agent PRs link back to the thread artifacts that motivated them?
