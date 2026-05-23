# Agent Control Plane Plan

## Source Of Truth

Threadbeat is moving away from a task-based model.

The product primitive is:

```text
human/heartbeat message -> thread -> inferred goal -> repo-backed agent sandbox
```

A message starts or resumes work. A task does not. If the implementation needs an
execution attempt boundary later, that boundary should be represented in thread
events and artifacts, not as a public or private `tasks` table.

## Core Flow

1. A human creates a thread with an agent repo and an initial JSON message.
2. Threadbeat appends the message to `messages`.
3. A goal-inference step reads the ordered message history and writes the current
   goal back onto the thread as JSON.
4. The worker decides whether the thread should run:
   - if the latest sandbox row is reachable and inside its idle window, reuse it;
   - otherwise create a new Daytona sandbox and append a new `sandboxes` row with
     the next `index`.
5. The sandbox clones the agent repo from `agents.repo_url` and
   `agents.default_branch`.
6. Threadbeat materializes thread context for the agent:
   - current inferred goal JSON;
   - ordered message history;
   - current artifact manifest;
   - thread and sandbox identifiers.
7. The agent runs `threadbeat-agent.mjs` or `threadbeat-agent.sh`.
8. Events stream back as thread events.
9. Large evidence uploads to object storage and is indexed in `artifacts`.
10. The agent appends an `agent` message or checkpoint when it yields.
11. The thread becomes `idle`, `completed`, or `failed`.

## Message Semantics

Messages are the interaction API. They are append-only JSON payloads.

Human text is still JSON:

```json
{
  "text": "research this, keep going from the last trace"
}
```

Heartbeats are also messages:

```json
{
  "text": "continue this thread",
  "reason": "scheduled heartbeat"
}
```

The LLM-facing goal is inferred from the full message set, not manually supplied
as a separate task body. `threads.goal_json` is the current distilled goal, and
older goal versions remain recoverable from message history and events.

## Current Abstraction

- `src/api/`: HTTP routes for agents, threads, messages, sandboxes, artifacts,
  heartbeats, and events.
- `src/db/`: Drizzle client plus CRUD for the same SQL primitives.
- `src/sandbox/`: Daytona sandbox lifecycle and shell execution.
- `src/worker/`: heartbeat draining now; next owner for thread resume/start
  decisions.

Keep this flat. Do not add a repo model, run table, task table, provider
registry, or scheduler runtime until a full-fidelity smoke proves the current
thread/message model cannot carry the behavior.

## Implementation Sequence

1. Finish deleting task-shaped API, DB, scripts, docs, and event filters.
2. Generate and apply a migration that drops `tasks`, removes `events.task_id`,
   makes `events.thread_id` required, and makes heartbeats thread-only with
   required `message_json`.
3. Keep CRUD smokes for:
   - agent registry;
   - thread creation;
   - JSON message append/list;
   - sandbox row indexing/current lookup;
   - artifact pointers;
   - thread heartbeat drain into a heartbeat message;
   - thread event enum roundtrip.
4. Keep the goal-inference smoke:
   - create a thread;
   - append multiple human messages;
   - run the inference step;
   - assert `threads.goal_json` captures the current goal as JSON.
5. Add the repo-start smoke:
   - create a thread with an agent repo;
   - append a human message;
   - start or resume the thread through the worker;
   - create/reuse a Daytona sandbox;
   - clone the repo;
   - materialize thread context;
   - run the agent entrypoint;
   - stream thread events;
   - append an agent checkpoint message.
6. Only after the repo-start smoke works, decide whether attempt boundaries need
   a simple `execution_id` field on events/artifacts.

## Tests To Keep

Every productionized primitive should keep the matching smoke:

- agent registry CRUD;
- thread state CRUD;
- event enum roundtrip on `thread_id`;
- Daytona clone/delete;
- Pi auth/model registry in Daytona;
- thread heartbeat message injection;
- goal inference from messages;
- repo-backed agent start/resume from a message, including truthful failure
  evidence when the sandbox cannot reach public web targets.

Delete any task-based script when it has no unique coverage after the thread
smoke exists.
