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

### v0.3: hosted singular server agent

Status: implemented.

Goal: move the working single-server harness to managed infrastructure and prove one long-lived agent can run on the server.

Ships:

- Railway-hosted Node service.
- Turso-hosted database.
- Stripe Projects provisioning notes and env sync.
- Startup schema initialization against Turso.
- Health checks suitable for Railway.
- Deployment runbook for local-to-hosted cutover.
- One hosted shared Pi SDK session running inside the server process.
- One hosted heartbeat running repeatedly against the server-side agent.

Does not ship:

- Modal agent workers.
- Task/executor abstraction.
- Multi-agent runtime.
- Multi-region or multi-instance scheduling.
- Strong distributed locking.

Done when:

- The same heartbeat API works against the Railway service.
- A hosted heartbeat run persists into Turso.
- A singular hosted Pi/DeepSeek agent executes a heartbeat at least twice on cadence.
- Local `.env` still contains only project-scoped secrets.

Verification report, 2026-05-05:

- Automatic checks passed locally: `npm run typecheck`, `npm run build`, `npm run lint`, `npm test`, `npm run smoke:api`.
- Live local check passed: `THREADBEAT_PI_DRY_RUN=0 THREADBEAT_RUN_TIMEOUT_SECONDS=60 npm run smoke:api`.
- Hosted checks passed: Railway `/health` returned 200 with runtime mode `pi-sdk`; `THREADBEAT_BASE_URL=https://threadbeat-production.up.railway.app npm run smoke:api` created and ran a hosted heartbeat.
- Cadence gate passed: hosted heartbeat `hb_75cccc0cb35f41338b8305a6cab5ae98` persisted seven successful Pi/DeepSeek runs in Turso, then was set inactive to stop spend.
- Providers touched: Railway hosting and Turso database through Stripe Projects; Cloudflare remains present in project state but unused by the app.
- State left running: Railway service online; no throwaway hosted smoke heartbeats left active.

### v0.4: reliable hosted singular agent

Status: in progress.

Goal: harden the single hosted agent before introducing any multi-agent runtime.

Ships:

- Server-streaming terminal control surface for the hosted Pi session.
- Multiple terminal listeners for interactive server-side Pi message events.
- CLI commands for sending messages, listening, runtime status/reset, sessions,
  heartbeats, runs, and events.
- Hosted soak test for one agent running one or more heartbeats for several hours.
- Event log for scheduler decisions, Pi session lifecycle, model calls, SQL writes, and reschedules.
- Better runtime controls for reset, pause, resume, compaction, and active-run visibility.
- Documented runtime memory semantics for the current shared persistent Pi
  session, plus explicit future modes for shared, per-heartbeat, and stateless
  execution.
- Run locking so one hosted process cannot overlap a heartbeat with itself.
- Clear failure policy for model errors, missing markdown, and timed-out runs.
- Minimal operator surface for inspecting the single agent and recent heartbeat history.
- Explicit v0.4 operator semantics: pause/deactivate stop future claims but do
  not cancel an already-active Pi run; manual `run-now --preserve-cadence`
  executes without moving `last_tick` or `next_tick`.

Does not ship:

- Modal implementation.
- Multiple agents.
- On-device implementation.
- Recipe/MCP bridge.

Done when:

- One hosted agent can run unattended for several hours.
- Multiple terminals can observe and send messages through the same hosted Pi
  runtime without starting local Pi sessions.
- Restarting the server preserves schedule state and resumes cleanly.
- The SQL log can explain every heartbeat run without reading process logs.

Readiness report, 2026-05-08:

- Operator surface is working: hosted CLI `send`, `listen`, `status`, `reset`,
  `sessions`, `heartbeats`, `runs`, and `events` commands all target the
  Railway service without starting local Pi.
- Multi-terminal behavior is proven: two hosted listeners observed the same
  server-side Pi message stream while a separate terminal sent a prompt.
- Shared memory behavior is proven: the hosted Pi session recalled prior
  interactive markers across separate CLI sends.
- Stateless interactive mode is proven: `send --stateless` did not see a marker
  stored in the shared hosted session.
- Heartbeat operator controls are working: pause/resume/run-now/deactivate were
  verified locally and against Railway.
- `run-now --preserve-cadence` is working: a hosted live run succeeded without
  moving `next_tick`, and emitted `heartbeat_schedule_preserved`.
- CLI inspection is usable: `--table` and bounded `--follow --count` checks work
  against hosted Turso state.
- Current hosted runtime is healthy: latest check showed `pi-sdk` running,
  active run empty, queue `0`, and no last error.
- All throwaway hosted test heartbeats are inactive after verification.

Remaining v0.4 gaps before marking complete:

- A multi-hour hosted unattended soak has not been rerun after the terminal
  control-plane additions.
- Restart-resume is mostly implied by Railway/Turso persistence but should get
  one explicit restart check before v0.4 is marked complete.

Recommendation:

- Do not start the v0.5 task/runtime refactor until either the user accepts the
  current v0.4 proof as sufficient for a POC, or the two remaining checks above
  are completed.

### v0.5: runtime refactor for future agents

Goal: introduce the abstraction needed for Modal and multi-agent execution, without changing the product surface yet.

Ships:

- `tasks` table for work requested by heartbeats.
- `task_events` table as the canonical append-only log.
- Runtime interface for `start`, `execute`, `stop`, `reset`, and `status`.
- Current hosted shared Pi session represented as the first runtime.
- Heartbeats create tasks instead of calling Pi directly.
- Scheduler claims tasks through SQL state transitions.
- Compatibility path preserving the existing single-agent heartbeat behavior.

Does not ship:

- Modal implementation.
- Multiple active agents.
- On-device implementation.
- Recipe/MCP bridge.

Done when:

- Existing hosted single-agent behavior works through the new task/runtime abstraction.
- The SQL log can reconstruct a run from queued to completed.
- A failed executor leaves the task in a clear terminal or retryable state.

### v0.6: Modal persistent agent runtime

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

### v0.7: multi-agent heartbeat orchestration

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

### v0.8: on-device daemon

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

### v0.9: capability policy and local state boundaries

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

### v0.10: Poke/Kitchen recipe bridge

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

## Verification gates

Each version should end with a short written check report in the commit or PR description:

- What was tested automatically.
- What was tested manually.
- What failed or was skipped.
- What state was left running.
- What credentials or providers were touched.

### v0.1 checks: local proof of concept

Automated checks:

- `npm run typecheck`
- `npm run build`
- `npm run lint`
- `npm test`

Manual checks:

- Start the server in dry-run mode.
- Create a session through HTTP.
- Create a heartbeat through HTTP.
- Let a 30-second heartbeat fire naturally, without forcing it due.
- Confirm one `heartbeat_runs` row is persisted.
- Start the server with live Pi/DeepSeek and confirm `/api/runtime/pi` reports a real session id.
- Run one tiny live heartbeat and confirm the persisted output is from DeepSeek.

Human check:

- Read the persisted prompt snapshot and verify it is the exact markdown-backed heartbeat the user intended to run.

### v0.2 checks: reliable single-server harness

Automated checks:

- Unit tests for event-log writes.
- Unit tests for timeout behavior.
- Unit tests for missing markdown failures.
- Unit tests for Pi reset behavior in dry-run/runtime-mock mode.
- Regression test proving failed runs still advance `last_tick` and `next_tick`.

Manual checks:

- Run a one-hour local soak test with a short cadence heartbeat.
- Trigger a manual Pi reset while the server remains up.
- Temporarily point a heartbeat at a missing markdown file and confirm a failed run and event log are recorded.
- Inspect `/health` and runtime endpoints during idle, active, failed, and reset states.

Human check:

- Read the event log for at least one successful run and one failed run and confirm it explains what happened without terminal logs.

### v0.3 checks: hosted singular server agent

Automated checks:

- Local test suite passes before deploy.
- Hosted `/health` check passes after deploy.
- Schema initialization against Turso is idempotent.
- API smoke test runs against the Railway URL.

Manual checks:

- Confirm Stripe Projects env was pulled and no Cloudflare env keys are needed by the app.
- Create a hosted session.
- Create a hosted heartbeat.
- Let the hosted heartbeat execute twice on cadence.
- Confirm both runs persist in Turso.
- Restart the Railway service and confirm the heartbeat schedule resumes.

Human check:

- Inspect the hosted run outputs and decide whether the single hosted agent is acting coherently enough to leave running.

### v0.4 checks: reliable hosted singular agent

Automated checks:

- Tests for SQL event ordering.
- Tests for run lock behavior.
- Tests for pause/resume/reset endpoints.
- Tests for timeout and retry policy.
- Tests for server restart recovery using an existing database.

Manual checks:

- Run a multi-hour hosted soak test.
- Restart the hosted process during idle.
- Restart the hosted process after a run completes.
- Simulate model failure by using a bad model/provider config.
- Verify the operator surface shows active run, last run, last error, and queue depth.

Human check:

- Review the last 10 hosted heartbeat cycles and verify the agent did not drift away from the intended markdown state.

### v0.5 checks: task log and runtime refactor

Automated checks:

- Existing heartbeat API regression tests still pass.
- Tests for task state transitions.
- Tests for task event creation.
- Tests for executor failure states.
- Tests that direct heartbeat execution and task-based execution produce equivalent run records.

Manual checks:

- Create a heartbeat and verify it creates a task.
- Watch the scheduler claim and complete the task.
- Force a task failure and confirm it is terminal or retryable according to policy.
- Confirm the same hosted single agent still runs normally after the refactor.

Human check:

- Read the task and event rows for a full run and confirm the lifecycle is understandable.

### v0.6 checks: Modal persistent agent runtime

Automated checks:

- Unit tests for Modal runtime request builders.
- Tests for agent status transitions.
- Tests for volume metadata persistence.
- Tests for task assignment to a Modal-backed agent.

Manual checks:

- Start one Modal-backed agent.
- Assign it a task.
- Confirm it writes output back to SQL.
- Stop the agent.
- Resume it and confirm filesystem state is still present.
- Start two agents and confirm they do not share a Pi session or workspace.

Human check:

- Inspect the Modal workspace after resume and verify the files reflect the intended task history.

### v0.7 checks: multi-agent orchestration

Automated checks:

- Tests for agent quota limits.
- Tests for spawn/assign/pause/resume actions.
- Tests for stuck-agent detection.
- Tests for prompt context assembly from agent states and task events.

Manual checks:

- Run one control heartbeat that manages two agents.
- Assign different tasks to each agent.
- Pause one agent while the other continues.
- Confirm the control heartbeat can summarize both agents.

Human check:

- Read the control heartbeat output and verify it makes correct decisions from SQL-visible state only.

### v0.8 checks: on-device daemon

Automated checks:

- Tests for device registration.
- Tests for capability lease creation and expiry.
- Tests for local-required task queueing.
- Tests for daemon disconnect/reconnect state.

Manual checks:

- Start the daemon and confirm the server sees the device online.
- Stop the daemon and confirm local-required tasks wait.
- Restart the daemon and confirm queued local tasks are claimed.
- Disable a capability and confirm no new tasks are assigned to it.

Human check:

- Inspect local task outputs and confirm raw local-only data is not persisted remotely unless explicitly allowed.

### v0.9 checks: capability policy

Automated checks:

- Tests for capability status changes.
- Tests for residency labels.
- Tests for revocation of active leases.
- Tests for blocked task assignment after disabling a capability.

Manual checks:

- Enable a capability.
- Run a task against it.
- Disable it.
- Confirm future tasks are blocked.
- Confirm existing allowed derived results remain readable.

Human check:

- Review a sample local capability run and verify the persisted result matches the intended residency policy.

### v0.10 checks: Poke/Kitchen recipe bridge

Automated checks:

- Tests for recipe registry loading.
- Tests for enabled/disabled/approval-required modes.
- Tests for webhook result ingestion.
- Tests for recipe invocation rows tied to tasks and heartbeats.

Manual checks:

- Register one safe test recipe.
- Invoke it from a heartbeat.
- Receive the webhook result.
- Disable the recipe and confirm invocation is blocked.

Human check:

- Review the recipe invocation and result rows and confirm they are safe to expose to later heartbeat context.

### v1.0 checks: durable control plane

Automated checks:

- Full regression suite across sessions, heartbeats, tasks, agents, devices, capabilities, and recipes.
- Restart recovery tests.
- Duplicate scheduler prevention tests.
- Long-running soak test fixtures.

Manual checks:

- Run a scenario where a heartbeat uses a Modal agent, waits for a local device capability, and invokes one approved recipe.
- Restart the server during the scenario and confirm it resumes.
- Confirm the operator surface shows the same state as SQL.

Human check:

- Reconstruct the full scenario from SQL rows and confirm no hidden state is required to understand what happened.

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

1. Get one hosted Pi + DeepSeek agent running on Railway against Turso.
2. Harden that singular hosted agent with event logs, resets, timeouts, and soak tests.
3. Refactor into task/runtime abstractions only after the singular hosted agent is stable.
4. Add Modal-backed persistent agents as the first multi-agent runtime.
5. Add multi-agent heartbeat orchestration.
6. Add on-device daemon and local capability policy.
7. Add Kitchen/recipe/MCP bridge.

The important invariant is that SQL remains the control log. Pi sessions, Modal sandboxes, local daemons, and external recipes are executors attached to that log, not separate sources of truth.
