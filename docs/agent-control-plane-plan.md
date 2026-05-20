# Agent Control Plane Plan

## Current Definition

An agent is a registry entry for a GitHub repo:

- `id`
- `name`
- `repo_url`
- `default_branch`

It is not a runtime, sandbox, scheduler row, attempt, or repo metadata mirror.

## Proven Primitives

The script harness has already proven these primitives end to end:

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

## Productionization Order

1. Keep `agents` as the thin GitHub repo registry.
2. Add `agent_id` to `tasks` only when task submission needs to resolve a repo from the registry.
3. Teach `POST /api/agents/:id/tasks` to expand the agent into a normal task spec:
   - `repo.url = agent.repo_url`
   - `repo.branch = agent.default_branch`
   - setup/main/verify stay in `spec_json`
4. Move the sample Pi setup from scripts into a production step runner only after the API can express an agent-backed task.
5. Move real Pi `createAgentSession` into an `agent` task step kind:
   - no runtime registry;
   - one Pi implementation;
   - emit model/session events as it runs.
6. Move GitHub repo create/push/clone/delete into explicit command/tool steps only if command-based execution becomes too fragile.
7. Preserve `tasks` as the execution unit and `events` as the return stream.

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
