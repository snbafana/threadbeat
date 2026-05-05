# threadbeat implementation roadmap

This repo currently proves the local TypeScript server loop:

- Fastify API
- raw SQL heartbeat state
- repo-relative markdown heartbeat contents
- one background scheduler
- one shared Pi SDK session
- DeepSeek-backed heartbeat execution

The next work is to turn that proof of concept into a real agent runtime.

## Implementation versions

### v0.1: local heartbeat proof of concept

Status: implemented.

Ships:

- TypeScript server process.
- Fastify JSON API.
- Local libSQL/SQLite database.
- Repo-relative markdown heartbeat contents.
- One background scheduler loop.
- One shared Pi SDK session.
- DeepSeek-backed execution.

Does not ship:

- Hosted deployment.
- Multi-agent execution.
- Durable event log beyond `heartbeat_runs`.
- Modal sandboxes.
- On-device daemon.

Done when:

- A real 30-second heartbeat fires through the scheduler and persists a successful Pi/DeepSeek run.

### v0.2: reliable single-server harness

Goal: make the current single-server loop robust enough to leave running.

Ships:

- `heartbeat_events` SQL log for scheduler, executor, runtime, and error events.
- Per-run timeout controls.
- Manual and automatic Pi session reset policy.
- Runtime health endpoint with active run, last run, last error, queue depth, and reset count.
- Provider/model fields on heartbeats, with DeepSeek defaults.
- Repeat-run soak test for one heartbeat running for at least one hour.

Does not ship:

- Modal sandboxes.
- Multiple scheduler instances.
- Device daemon.
- External recipe tools.

Done when:

- A heartbeat can run repeatedly for one hour without manual intervention.
- Failed runs produce actionable SQL events.
- Resetting the shared Pi session does not lose heartbeat state.

### v0.3: hosted server and hosted state

Goal: move the working single-server harness to managed infrastructure.

Ships:

- Railway-hosted Node service.
- Turso-hosted database.
- Stripe Projects provisioning notes and env sync.
- Startup schema initialization against Turso.
- Health checks suitable for Railway.
- Deployment runbook for local-to-hosted cutover.

Does not ship:

- Modal agent workers.
- Multi-region or multi-instance scheduling.
- Strong distributed locking.

Done when:

- The same heartbeat API works against the Railway service.
- A hosted heartbeat run persists into Turso.
- Local `.env` still contains only project-scoped secrets.

### v0.4: task log and executor abstraction

Goal: separate "what should happen" from "which runtime does it."

Ships:

- `tasks` table for work requested by heartbeats.
- `task_events` table as the canonical append-only log.
- Runtime interface for `start`, `execute`, `stop`, `reset`, and `status`.
- Current shared Pi session represented as the first runtime.
- Heartbeats create tasks instead of calling Pi directly.
- Scheduler claims tasks through SQL state transitions.

Does not ship:

- Modal implementation.
- On-device implementation.
- Recipe/MCP bridge.

Done when:

- Existing heartbeat behavior is preserved through the new task abstraction.
- The SQL log can reconstruct a run from queued to completed.
- A failed executor leaves the task in a clear terminal or retryable state.

### v0.5: Modal persistent agent runtime

Goal: make remote agents real execution targets with persistent filesystems.

Ships:

- Modal runtime implementation.
- Base image with Node, Pi, threadbeat runner, and DeepSeek env wiring.
- Modal Volume per persistent agent workspace.
- `agents` table tracking runtime provider, volume path, status, active task, and last heartbeat.
- Heartbeat actions that can start, stop, and resume Modal-backed agents.
- Agent output written back to the SQL task/event log.

Does not ship:

- On-device local capabilities.
- Cross-agent orchestration beyond SQL-visible task dispatch.
- Full snapshot/restore policy beyond Volume-backed persistence.

Done when:

- A heartbeat can start a Modal agent, assign it a task, observe completion, stop it, and later resume with its filesystem state still present.
- Two Modal agents can run separate tasks without sharing one Pi session.

### v0.6: multi-agent heartbeat orchestration

Goal: let heartbeats coordinate multiple remote agents instead of only one executor.

Ships:

- Heartbeat prompt context includes visible agent states and recent task events.
- Actions for `spawn_agent`, `assign_task`, `pause_agent`, `resume_agent`, and `summarize_agent`.
- Per-agent heartbeat or liveness check.
- Basic quota controls for maximum active agents and maximum running tasks.
- Failure handling for stuck, crashed, or unreachable agents.

Does not ship:

- Local machine/device attachment.
- External recipes.

Done when:

- One control heartbeat can manage at least two Modal agents over multiple task cycles.
- Agent state remains understandable from SQL rows and events alone.

### v0.7: on-device daemon

Goal: attach the user's device as a capability provider when it is online.

Ships:

- Local daemon process.
- Device registration and heartbeat.
- Capability advertisement for local filesystem, browser state, Cued, and desktop/CUA placeholders.
- Lease model for assigning local tasks only while available.
- Local task execution logs synced into the SQL event log.
- Offline behavior for queued local-required tasks.

Does not ship:

- Broad personal-data export.
- Fully automated desktop/CUA without explicit capability policy.
- Mobile or multi-user device fleet support.

Done when:

- Closing or stopping the daemon makes local-required tasks wait.
- Restarting the daemon causes queued local tasks to be claimed and logged.
- Remote heartbeats keep running while local capabilities are unavailable.

### v0.8: capability policy and local state boundaries

Goal: make hook-in and hook-out behavior explicit.

Ships:

- Capability policy table.
- Capability statuses: `enabled`, `disabled`, `requires_approval`.
- State residency labels: `local_only`, `derived_exportable`, `mirrored`.
- Revocation flow for active leases.
- Redaction and result-class metadata on local task outputs.

Does not ship:

- Full UI for policy management.
- Automatic semantic redaction.

Done when:

- A capability can be enabled, used, disabled, and prevented from receiving future tasks.
- Raw local-only outputs are not persisted remotely unless the policy allows it.

### v0.9: Poke/Kitchen recipe bridge

Goal: make external automations callable through controlled recipe tools.

Ships:

- Recipe registry.
- MCP-style tool bridge for enabled Kitchen recipes.
- Invocation table tied to tasks and heartbeat runs.
- Webhook receiver for recipe results.
- Approval modes: `automatic`, `ask_first`, `disabled`.

Does not ship:

- Arbitrary unregistered tools.
- Full marketplace/discovery UI.

Done when:

- A heartbeat can invoke one enabled recipe, persist the invocation, receive the result, and include that result in later context.
- Disabled recipes cannot run silently.

### v1.0: durable agent control plane

Goal: threadbeat becomes a usable multi-runtime agent system.

Ships:

- Hosted server and hosted SQL state.
- Reliable heartbeat loop.
- Task/event log.
- Shared Pi runtime.
- Modal persistent agents.
- On-device daemon.
- Capability policy.
- Recipe bridge.
- Basic operator UI or TUI for sessions, heartbeats, agents, tasks, devices, capabilities, and recipe invocations.

Done when:

- A long-running heartbeat can coordinate remote agents, wait for local device access, use an approved recipe, and keep all state reconstructible from SQL.

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
