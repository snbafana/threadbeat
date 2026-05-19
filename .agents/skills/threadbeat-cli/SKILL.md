# Threadbeat CLI Skill

Use this skill when operating or changing Threadbeat's current CLI.

The CLI is a smoke driver for the Daytona task substrate. It is not a cockpit,
branch operator, TUI, or agent runner.

Canonical commands:

- `npm run cli -- task create <json-file>`
- `npm run cli -- task list`
- `npm run cli -- task get <task_id>`
- `npm run cli -- worker drain-once`
- `npm run cli -- events follow --task <task_id>`

Keep the CLI small. Add a command only when it directly helps create tasks,
drain the worker, inspect task state, or read events.

When `scripts/threadbeat-cli.ts` changes, update this skill and at least one
smoke/test path in the same slice.
