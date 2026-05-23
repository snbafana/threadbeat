# Threadbeat Agent Hook

Threadbeat is currently intentionally reduced to the SQL datamodel plus CRUD
surface.

Keep the durable product model small:

- `drizzle/schema.ts` owns the datamodel.
- `src/db` owns direct CRUD/data-access functions.
- `src/api` owns HTTP route registration for that CRUD surface.
- `src/input.ts` owns request validation schemas.

Do not add workers, sandbox runtimes, scripts, smokes, schedulers, runtime
wrappers, provider registries, CLI entrypoints, or agent execution code back
into this repo until the user explicitly asks for that expansion again.

For cleanup/refactor work, load the `code-cleanup` skill before editing and
prefer deleting parallel systems over preserving compatibility branches.
