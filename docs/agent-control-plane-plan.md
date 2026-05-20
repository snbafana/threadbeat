# Agent Control Plane State

## Current Definition

An agent is a registry entry for a GitHub repo:

- `id`
- `name`
- `repo_url`
- `default_branch`

It is not a runtime, sandbox, scheduler row, attempt, or repo metadata mirror.

An agent task is:

1. resolve `agent_id` to `repo_url` and `default_branch`;
2. clone that repo in Daytona;
3. create a `runs/{task_id}` branch;
4. materialize `.threadbeat/task.json` plus input files;
5. run `threadbeat-agent.mjs` or `threadbeat-agent.sh`;
6. commit and push the run branch;
7. stream all lifecycle/output through `events`.

## Proven Primitives

The smoke harness proves these primitives end to end:

- create/delete Daytona sandboxes;
- clone the current Threadbeat repo;
- materialize a sample Pi repo inside the sandbox;
- inject allowlisted credentials without printing them;
- validate Pi `AuthStorage` and `ModelRegistry`;
- run a real Pi `createAgentSession`;
- create, push, clone, verify, and delete a disposable GitHub repo;
- run realistic Python finance graph generation and artifact checks;
- stream task lifecycle/stdout through `events`;
- roundtrip every declared event enum through DB/API event streaming.
- register a GitHub repo as an agent, submit an ask, run the agent, push a
  versioned `runs/{task_id}` branch, verify branch artifacts, and delete the
  disposable remote.

## Current Abstraction

- `src/api/`: HTTP routes only.
- `src/worker/`: task claiming, manual drain, and server-owned concurrency loop.
- `src/db/`: Drizzle client plus CRUD for agents, tasks, and events.
- `src/sandbox/`: Daytona sandbox lifecycle and shell command event emission.
- `src/agent/`: agent task execution, ask materialization, entrypoint invocation, and run branch push.

Keep this flat. Do not add a separate repo model, run table, provider registry,
or scheduler state until a full-fidelity smoke proves the current model cannot
carry the behavior. Process concurrency belongs in `src/worker/`, not in new DB
tables.

## Next Productionization

1. Replace the script-owned sample Pi agent with a real agent repo that exposes
   `threadbeat-agent.mjs` or `threadbeat-agent.sh`.
2. Move the finance/Pi harness behavior into that agent repo, not into a new
   Threadbeat runtime registry.
3. Keep `POST /api/agents/:id/tasks` as the task assignment path: it submits an
   ask to an agent, creates one task, and returns events.
4. Add artifact indexing only after branch artifacts alone are insufficient for
   a real consumer.
5. Add attempts/runs only when retry semantics need separate durable rows.

## Tests To Keep

Every productionized primitive should keep the matching smoke:

- agent registry CRUD;
- event enum roundtrip;
- Daytona clone/delete;
- Pi auth/model registry;
- real Pi session;
- real disposable GitHub remote;
- finance/Python artifacts;
- full suite runner.

Delete a script when a stronger full-fidelity script proves the same behavior.
