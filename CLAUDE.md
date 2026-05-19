# Threadbeat Agent Notes

Threadbeat is currently a minimal Daytona task substrate.

Stay inside the V1 boundary:

- no agents
- no Pi
- no heartbeat scheduler
- no TUI
- no replay/action-trace system
- no extra provider abstraction beyond the narrow Daytona adapter

The core files that should matter are:

- `schema/bootstrap.sql`
- `src/types.ts`
- `src/taskSpec.ts`
- `src/db.ts`
- `src/sandboxProvider.ts`
- `src/daytonaProvider.ts`
- `src/worker.ts`
- `src/server.ts`
- `scripts/threadbeat-cli.ts`
- `test/smoke.ts`
- `test/fixtures/repo-matrix.json`

Use tests and smokes as the design loop. If a smoke exposes an awkward API or
schema shape, simplify it immediately instead of adding compatibility layers.

Run the cheap checks before handing off:

```bash
npm test
npm run smoke:api
npm run typecheck
npm run lint
npm run build
```

Run live Daytona checks when credentials are available:

```bash
npm run smoke:daytona
npm run smoke:live
```
