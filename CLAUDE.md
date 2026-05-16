# Threadbeat Agent Notes

Threadbeat is moving toward a durable, branch-native, CLI-driven control plane.

Use the repo-local skill at `.agents/skills/threadbeat-cli/SKILL.md` before
operating or editing the control-plane CLI. Keep that skill and
`docs/control-plane-cli-cleanup-plan.md` current when command names or generated
operator commands change.

Default operator path:

- `npm run cli -- runs cp-status <session> --format text`
- `npm run cli -- runs cp-next <session> --format text`
- `npm run cli -- runs cp-operate <session> --format text`
- `npm run cli -- runs cp-workers <session> --format text`

The `cp-*` commands imply routine defaults: server mode, status summary,
worker reconciliation for `cp-operate`, dry-run unless `--confirm`, and retired
worker visibility where recovery state matters.

Keep normal results branch-native. Promotion, PR creation, and merging are
explicit follow-up actions, not default run completion.
