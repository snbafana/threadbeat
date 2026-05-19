# Threadbeat Agent Notes

Threadbeat is currently a minimal Daytona task substrate.

When a long cleanup/refactor thread reveals repeated user preferences, update
`.agents/skills/code-cleanup/SKILL.md`. For code cleanup, simplification, bloat
removal, or abstraction review, load the `code-cleanup` skill before editing.

Stay inside the V1 boundary:

- no agents
- no Pi
- no heartbeat scheduler
- no TUI
- no replay/action-trace system
- no extra provider abstraction beyond the narrow Daytona adapter

The core files that should matter are:

- `schema/bootstrap.sql`
- `drizzle/schema.ts`
- `drizzle.config.ts`
- `src/db.ts`
- `src/daytonaProvider.ts`
- `src/worker.ts`
- `src/server.ts`
- `scripts/threadbeat-cli.ts`
- `test/smoke.ts`
- `test/fixtures/repo-matrix.json`

Use tests and smokes as the design loop. If a smoke exposes an awkward API or
schema shape, simplify it immediately instead of adding compatibility layers.

Run static checks before handing off:

```bash
npm run typecheck
npm run lint
npm run build
```

Run `npm test` and `npm run smoke:api` only when a server is running with a
reachable `DATABASE_URL`.

Run live Daytona checks when credentials are available:

```bash
npm run smoke:daytona
npm run smoke:live
```
