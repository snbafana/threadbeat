# Threadbeat TUI and CLI control plane plan

Goal: make `threadbeat` operable from terminals before building a richer UI.

The terminal surface should make the hosted server feel like a shared agent
session:

- one terminal can listen to server-side Pi activity
- another terminal can send a message into the same hosted Pi runtime
- multiple senders are serialized by the server runtime lock
- heartbeats can be created, paused, resumed, ticked, and inspected from CLI
- all later work should move toward SQL-backed state rather than hidden process
  memory

## Runtime memory model

Current behavior is intentionally one shared persistent Pi session:

- Every heartbeat creates a new `heartbeat_runs` SQL row.
- Every heartbeat prompt is sent to the same server-side Pi `AgentSession`.
- Every interactive CLI message is also sent to that same `AgentSession`.
- Calls are serialized by the runtime lock, so one call runs at a time.
- The Pi session is only disposed on server shutdown, manual reset, or automatic
  reset after a runtime failure.

Implication: SQL runs are separate records, but Pi memory is shared. Heartbeats
can behave like a persistent agent mind across ticks, and interactive messages
can affect later heartbeat context.

This is useful for v0.4 because the goal is a singular hosted agent. It is not
the right default for all future workloads. Before v0.5/v0.6, choose explicit
runtime memory modes:

- `shared`: default behavior; one long-lived Pi session for all heartbeats and
  interactive messages.
- `stateless` interactive sends: implemented for `npm run cli -- send --stateless`;
  uses a one-off Pi session without reading from or writing to the shared
  hosted conversation.
- `per-heartbeat`: one long-lived Pi session per heartbeat id, preserving local
  continuity without cross-heartbeat or interactive bleed.
- `stateless` heartbeat runs: not implemented yet; reset or recreate the Pi
  session per execution, slower but most deterministic.

Open policy decisions:

- Whether interactive CLI messages should share the same session as scheduler
  heartbeats by default.
- Whether pausing/deactivating an active heartbeat should allow the in-flight
  run to finish, cancel it, or finish but avoid rescheduling from stale state.

## Current v0.4 slice

Implemented:

- `GET /api/runtime/pi/messages/listen`
  - NDJSON stream of interactive Pi message events.
  - Multiple terminals can subscribe concurrently.
  - This is process-local broadcast for now, not durable history.
- `POST /api/runtime/pi/message/stream`
  - Still streams back to the sender.
  - Also broadcasts `message_started`, `message_delta`, `message_done`, and
    `message_error` to listeners.
  - Uses the same shared server-side Pi session and lock as heartbeats.
- `npm run cli -- send "message"`
  - Sends to the configured server and streams the answer.
- `npm run cli -- listen`
  - Subscribes to server-side message events.
- `npm run cli -- heartbeats ...`
  - Lists, creates, patches, pauses, resumes, runs now, ticks, and inspects
    heartbeat runs.
- `npm run cli -- heartbeats run-now <id> --preserve-cadence`
  - Executes immediately without advancing `last_tick` or `next_tick`.
  - Plain `run-now` keeps scheduler semantics and advances cadence.
- `--table` output for status, sessions, heartbeats, runs, and events.
  - JSON remains the default for scripts; table mode is for terminal operators.

## Intended operator commands

Hosted default:

```bash
npm run cli -- listen
npm run cli -- send "Say only: hello"
npm run tui
```

Local target:

```bash
THREADBEAT_BASE_URL=http://127.0.0.1:8000 npm run cli -- listen
THREADBEAT_BASE_URL=http://127.0.0.1:8000 npm run cli -- send "local test"
```

Heartbeat lifecycle:

```bash
npm run cli -- sessions create "operator"
npm run cli -- heartbeats create \
  --session <session_id> \
  --title "roadmap worker" \
  --cadence 60 \
  --contents contents/tui-control-loop.md
npm run cli -- heartbeats deactivate <heartbeat_id>
npm run cli -- heartbeats activate <heartbeat_id>
npm run cli -- heartbeats pause <heartbeat_id>
npm run cli -- heartbeats resume <heartbeat_id>
npm run cli -- heartbeats run-now <heartbeat_id>
npm run cli -- heartbeats tick <heartbeat_id>
npm run cli -- heartbeats runs <heartbeat_id>
npm run cli -- events --heartbeat <heartbeat_id> --limit 20
```

## Tests and checks

Automated:

- `npm run typecheck`
- `npm run build`
- `npm run lint`
- `npm test`
- Smoke assertion that `POST /api/runtime/pi/message/stream` emits
  `start/delta/done`.
- Smoke assertion that a live listener connected to
  `/api/runtime/pi/messages/listen` receives `message_started`,
  `message_delta`, and `message_done` for a sent message.

Manual:

- Start local dry-run server.
- In terminal A, run `THREADBEAT_BASE_URL=http://127.0.0.1:<port> npm run cli -- listen`.
- In terminal B, run `THREADBEAT_BASE_URL=http://127.0.0.1:<port> npm run cli -- send "Say only: local-ok"`.
- Confirm terminal A sees the user message and streamed Pi answer.
- Repeat against Railway with a tiny prompt.
- Create one heartbeat through CLI, let it run once, inspect runs/events, then
  deactivate it.

Human checks:

- Confirm listener output is readable enough to operate from multiple terminals.
- Confirm heartbeat CLI commands expose enough state to avoid opening the
  Railway/Turso dashboards for normal operation.
- Decide whether interactive messages need durable SQL history before the next
  multi-agent refactor.

## Next implementation units

1. CLI ergonomics.
   - Compact table output in addition to JSON is implemented.
   - JSON remains the default machine-readable mode.
   - `--follow` for runs/events is implemented as client-side polling, with
     `--count <n>` for bounded checks.
2. TUI process split.
   - Keep `send` and `listen` as composable CLI commands.
   - Later replace the simple readline TUI with a richer curses-style interface
     only after the control API stabilizes.
3. Heartbeat action hardening.
   - Optional `run-now` behavior that does not perturb cadence is implemented.
   - Add reset or compact actions once the runtime policy is clearer.
4. SQL-first control plane.
   - Move interactive sends into task rows.
   - Make heartbeats and interactive sends share the same task/runtime pipeline.
5. Durable interactive message history, if it becomes necessary.
   - Defer until process-local broadcast is insufficient.
   - Prefer implementing it as part of the later task/runtime log instead of a
     separate chat transcript.

## Non-goals for this layer

- No Modal agents yet.
- No multi-agent scheduler yet.
- No local device daemon yet.
- No browser or desktop/CUA capability bridge yet.
- No durable websocket infrastructure until the SQL event model is clear.
