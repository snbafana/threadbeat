# Modal Control Plane Plan

## Phase 0: Clean Rewrite Boundary

Archive the existing hosted Pi heartbeat prototype and rebuild the root around
the new control-plane primitives. Keep the old code available for reference, but
do not thread new Modal work through it.

Current archive:

```text
archive/2026-05-08-pre-modal-rewrite/
```

## Phase 1: API, CLI, and Tables

Build a callable server with four primitives:

- `agents`: Git-backed durable identities.
- `heartbeats`: wakeup policy rows, not execution yet.
- `sandboxes`: provider-backed runtime instances.
- `messages`: append-only streaming state.

The first API surface:

```text
POST /api/agents
GET  /api/agents
GET  /api/agents/:id
POST /api/agents/:id/sandboxes
GET  /api/sandboxes
GET  /api/sandboxes/:id
POST /api/sandboxes/:id/exec
POST /api/sandboxes/:id/stop
GET  /api/messages
GET  /api/messages/listen
```

## Phase 2: Modal Sandbox Provider

Make Modal an implementation of a narrow provider interface:

```ts
start(input) -> providerSandboxId
exec(providerSandboxId, command[]) -> stdout/stderr/exitCode
stop(providerSandboxId)
```

This phase proves that the server can create a sandbox, run commands, capture
output, persist messages, and stop the sandbox. It does not include Pi.

## Phase 3: Hosted Git

This is a separate phase before AI execution.

Goals:

- Use GitHub as the durable Git infrastructure for agent bodies when configured
  with `THREADBEAT_GITHUB_OWNER` and `THREADBEAT_GITHUB_TOKEN`.
- Clone or fork a template agent repo into a durable hosted Git repo.
- Store `repo_url`, `default_branch`, `current_ref`, and visible Git links on
  the agent row.
- Store each agent's hosted Git owner/repo and redacted remote URL separately
  from the authenticated remote URL.
- Add persisted run branch planning with compare/tree links before any sandbox
  execution starts.
- Add git status/diff/commit metadata.
- Add a bootstrap action that starts a sandbox, installs git if needed, clones
  the agent repo into `/workspace/agent`, checks out the current ref, and emits
  all stdout/stderr as messages.

Important invariant:

```text
Hosted Git is durable state.
Modal is disposable compute.
Authenticated remote URLs are generated on demand and not stored.
Promotion happens through Git refs and commits.
```

Storage layers:

- GitHub repo as the canonical agent body.
- Modal Volume for dependency caches or large reusable artifacts.
- Modal snapshots later for warm starts.

Do not use a Modal Volume as the canonical mutable agent state in the first
implementation.

## Phase 4: Agent Run Service

Add a single service that composes:

1. load agent
2. create run branch
3. start sandbox
4. clone repo/current ref
5. write `work/inputs/task.md`
6. run a command in the sandbox
7. commit outputs
8. push run branch
9. stop sandbox by default

At this phase the command can still be a fixed shell script. The goal is to make
Git history and message streaming reliable before adding Pi.

## Phase 5: Pi in Agent Sandbox

Install and run Pi inside the sandbox checkout. This is separate from the server
Pi/operator use case.

The agent sandbox Pi should:

- run with `cwd=/workspace/agent`
- use writable tools scoped to that checkout
- read `AGENTS.md`, `.pi/prompts`, `.pi/skills`, and state files
- write `work/outputs/result.md`
- let Threadbeat commit and push the result

## Phase 6: Self-Improvement

Self-improvement is a special run kind on a branch.

Allowed self-edit targets:

- `AGENTS.md`
- `.pi/prompts/**`
- `.pi/skills/**`
- `.pi/extensions/**`
- `agent/state/**`
- `evals/**`

Promotion must be explicit. The running agent should not mutate the promoted
branch in place.
