# threadbeat

Threadbeat is currently just the SQL datamodel plus CRUD access through `src/db`
and `src/api`.

Kept surface:

- `drizzle/schema.ts`: database tables and enums.
- `src/db`: direct CRUD/data-access functions.
- `src/api`: Fastify route registration for the CRUD surface.
- `src/input.ts`: request validation schemas.

Removed surface:

- worker loops;
- sandbox/runtime execution;
- scripts and smokes;
- CLI;
- deploy/runtime wrappers;
- planning docs.

## Commands

```bash
npm run typecheck
npm run lint
npm run build
npm run db:generate
npm run db:migrate
```
