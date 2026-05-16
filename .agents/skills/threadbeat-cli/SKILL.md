# Threadbeat CLI Operator Skill

Use this skill when operating or changing Threadbeat's CLI-driven control
plane.

## Canonical Control Plane Path

Prefer these commands in docs, smoke tests, and generated next-step queues:

- `npm run cli -- runs cp-status <session> --format text`
- `npm run cli -- runs cp-next <session> --format text`
- `npm run cli -- runs cp-operate <session> --format text`
- `npm run cli -- runs cp-operate <session> --confirm --format text`
- `npm run cli -- runs cp-workers <session> --format text`
- `npm run cli -- runs cp-results <session> --next --format text`
- `npm run cli -- runs cp-branches <session> --resumable --format shell --commands-only`

The `cp-*` commands default the routine flags:

- server-backed mode is implied.
- `cp-status` implies summary mode.
- `cp-operate` implies worker reconciliation and dry-run unless `--confirm` is
  supplied.
- `cp-workers`, `cp-worker-progress`, and `cp-worker-terminals` include retired
  workers by default so recovery state is visible.

## Live Durable Run Proof

For a credential-backed proof, verify this chain:

1. `npm run cli -- preflight`
2. `npm run cli -- agents init --name <name> --live`
3. `npm run cli -- runs step --agent <agent> --objective "<task>" --bootstrap --check-runtime --finalize -- <command>`
4. `npm run cli -- runs inspect-result <run> --checkout-dir /tmp/<run>-result`
5. `npm run cli -- sandboxes stop-running --agent <agent>`

The expected durable result is a pushed branch or result commit in hosted Git.
Modal sandboxes are disposable and should be stopped after the proof.

## Update Rule

When `scripts/threadbeat-cli.ts` changes CLI names or generated command queues,
update this skill and `docs/control-plane-cli-cleanup-plan.md` in the same
slice. Add or adjust a smoke test before removing any compatibility command.

## Boundaries

Branch-native inspection is the default. Do not make PR creation or promotion
part of normal run completion unless explicitly requested.
