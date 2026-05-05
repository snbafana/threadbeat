# codexmux

Status: active

Purpose: Cloudflare-first control plane for a Codex-native tmux:
- durable sessions
- durable heartbeat prompt objects
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
- heartbeat object shape:
  - `title`
  - `kind`
  - `cadence_seconds`
  - `prompt`
  - `status`
  - `last_tick_at`
  - `next_tick_at`

Next step:
- run `npm install`
- initialize the D1 schema
- start local dev with `npm run dev`

Notes:
- `stripe projects env --pull` has already populated `.env`
- `R2` is not provisioned yet because Stripe Projects requires billing setup for usage-based storage
- Queue and Browser Run are provisioned but intentionally unused in the first cut
- this is the hosted control-plane only; local brokered capabilities come later
- a heartbeat is modeled as a prompt object that can be edited and then fed back into an agent on a deterministic cadence
