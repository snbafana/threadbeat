# threadbeat implementation roadmap

This repo currently proves the local TypeScript server loop:

- Fastify API
- raw SQL heartbeat state
- repo-relative markdown heartbeat contents
- one background scheduler
- one shared Pi SDK session
- DeepSeek-backed heartbeat execution

The next work is to turn that proof of concept into a real agent runtime.

## 1. Pi + DeepSeek harness

Goal: make the current harness reliable enough to run many heartbeat prompts over time.

Build:

- Add execution tracing around scheduler pick-up, prompt materialization, Pi start, Pi completion, SQL write, and heartbeat reschedule.
- Add a durable `heartbeat_events` or `task_events` SQL log so the system can reconstruct what happened without reading process logs.
- Add timeout and cancellation controls per heartbeat run.
- Add explicit session reset and compaction policies for the shared Pi session.
- Add model/provider config per heartbeat, while keeping DeepSeek as the default cheap-token executor.
- Add a small admin surface for runtime health, queue depth, active run, last error, and reset.

Success criteria:

- A heartbeat can run repeatedly for hours without manual intervention.
- Failed runs are recorded with enough context to debug.
- The shared Pi session can be reset without losing the scheduler or DB state.

## 2. Modal infrastructure for persistent agents

Goal: use Modal as the first real sandbox runtime for spinning up, pausing, resuming, and tearing down agents that need their own filesystem and process space.

Build:

- Define an internal runtime interface for `createAgent`, `startAgent`, `stopAgent`, `snapshotAgent`, `restoreAgent`, and `destroyAgent`.
- Add Modal as the first implementation of that runtime interface.
- Create a base image with Node, Pi, DeepSeek env wiring, repo checkout tools, and the threadbeat agent runner.
- Use Modal Volumes for persistent agent filesystems and named workspaces.
- Add SQL state for sandboxes: agent id, runtime provider, volume id/path, status, last heartbeat, current task, and last snapshot.
- Let heartbeats dispatch actions into separate Modal agents rather than only the shared local Pi session.
- Add heartbeat-driven automations that can coordinate across multiple Modal sandboxes.

Success criteria:

- A heartbeat can start a Modal-backed agent, write work into its SQL log, and observe the result.
- An agent can be stopped and resumed with its filesystem still present.
- Multiple agents can run separate tasks without sharing one Pi session.

## 3. On-device daemon

Goal: attach the user's machine as a capability provider when it is open and online.

Build:

- Create a local daemon that connects to threadbeat and advertises device presence.
- Add capability registration for local-only tools such as filesystem access, browser state, Cued, and desktop/CUA.
- Add a lease model so the server can assign local tasks only while the device is available.
- Add local execution logs that sync back into the SQL event log.
- Add offline behavior: queued local-required tasks wait until the daemon reconnects.
- Add revocation behavior: if the device closes or a capability is disabled, in-flight work stops cleanly.

Success criteria:

- When the laptop is online, the daemon can claim and execute local tasks in the background.
- When the laptop is offline, remote heartbeats continue and local tasks remain queued.
- Raw local state does not leave the device unless a capability explicitly allows it.

## 4. Poke integration through Kitchen, recipes, and MCP-style tools

Goal: expose external automations as selectable tools and recipes that agents can invoke through a controlled interface.

Build:

- Model Kitchen recipes as callable tool definitions with explicit inputs, outputs, and permissions.
- Add an MCP-style bridge that maps recipes into agent tools.
- Add approval policy per recipe: automatic, ask-first, disabled.
- Add webhook delivery for recipe results back into the SQL event log.
- Add recipe invocation records tied to heartbeat runs and agent tasks.
- Add a small registry surface for installed recipes, enabled tools, and recent invocations.

Success criteria:

- A heartbeat can select an enabled recipe/tool and invoke it through the bridge.
- The invocation and result are persisted in the SQL log.
- Disabled or approval-required recipes cannot run silently.

## Ordering

1. Harden the Pi + DeepSeek harness.
2. Add the SQL event log.
3. Add Modal-backed agent runtime.
4. Add on-device daemon.
5. Add Kitchen/recipe/MCP bridge.

The important invariant is that SQL remains the control log. Pi sessions, Modal sandboxes, local daemons, and external recipes are executors attached to that log, not separate sources of truth.
