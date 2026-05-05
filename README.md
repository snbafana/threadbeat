# threadbeat

Status: active

Purpose: Cloudflare-first control plane for thread heartbeats over time:
- durable sessions
- durable heartbeat objects
- later attachment of local-only capabilities like `cued` and desktop/CUA

Provisioned via Stripe Projects:
- Cloudflare Workers free plan
- Cloudflare Workers service: `control-plane`
- Cloudflare D1: `control-db`
- Cloudflare Queue: `events-queue`
- Cloudflare Browser Run: `remote-browser`

Current shape:
- `src/index.ts`: minimal Worker with session routes plus first-class editable heartbeats
- `schema/control-plane.sql`: initial D1 schema
- `wrangler.jsonc`: local Cloudflare worker config using the provisioned D1 name
- `scripts/run-due-heartbeats.mjs`: external runner that polls due heartbeats, reads markdown, invokes Pi, records runs, and ticks heartbeats
- heartbeat object shape:
  - `title`
  - `cadence`
  - `contents`
  - `status`
  - `last_tick`
  - `next_tick`
- heartbeat run shape:
  - `heartbeat_id`
  - `executor`
  - `model`
  - `status`
  - `prompt_snapshot`
  - `output`
  - `error`

Next step:
- run `npm install`
- initialize the D1 schema
- start local dev with `npm run dev`
- test the runner with `THREADBEAT_DRY_RUN=1 npm run run:due`

Notes:
- `stripe projects env --pull` has already populated `.env`
- `R2` is not provisioned yet because Stripe Projects requires billing setup for usage-based object storage
- Queue and Browser Run are provisioned but intentionally unused in the first cut
- the Worker is only the control plane; it stores schedules and runs but does not execute models itself
- a heartbeat stores a markdown file path in `contents`; the runner reads the file body from the repo checkout
- the Pi + DeepSeek path is intended for the runner process, not for the Worker runtime
