# Threadbeat Agent Hook

When a long cleanup/refactor thread reveals repeated user preferences, update `.agents/skills/code-cleanup/SKILL.md`.
For code cleanup, simplification, bloat removal, or abstraction review, load the `code-cleanup` skill before editing.
Keep the skill short: durable principles only, not a full process document.

Build agent-native behavior through full-fidelity smoke tests before promoting it into production abstractions. Prefer test/script harnesses that exercise the real external path end to end: create a task, route it to Daytona, inject only allowlisted credentials, run Pi or other agents in the sandbox, stream events back, verify artifacts, and clean up external resources.

Keep the durable product model small while testing new capabilities:

- `tasks` is the execution unit.
- `events` is the return stream.
- Do not reintroduce `runs`, attempts, scheduler state, or provider registries until tests prove the current task/event model cannot express the behavior.
- If a script-only implementation proves useful, collapse it into the existing worker/task path instead of creating a parallel runtime.
- If a newer full-fidelity smoke covers a weaker modeled smoke, delete the weaker one.

For agent-side changes, maintain smokes that prove:

- every declared event enum roundtrips through the DB/API stream;
- Daytona clone/delete and sandbox cleanup work;
- Pi `AuthStorage`/`ModelRegistry` works with safely injected credentials;
- real Pi `createAgentSession` works inside a task;
- real GitHub create/push/clone/delete works through a disposable repo and does not leak tokens into stdout events;
- realistic Python/data workloads produce and verify artifacts.
