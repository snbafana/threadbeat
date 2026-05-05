# Cloudflare Stack

This project currently uses Cloudflare as the hosted substrate provisioned through Stripe Projects.

Provisioned resources:
- Workers free plan
- Workers service: `control-plane`
- D1 database: `control-db`
- Queue: `events-queue`
- Browser Run service: `remote-browser`

Current architecture:
- Workers hosts a tiny HTTP control plane
- D1 stores sessions, heartbeat objects, and heartbeat runs
- Queues and Browser Run are provisioned but not used in the first cut

Not yet provisioned:
- R2 artifacts bucket
Why:
- Stripe Projects requires billing setup before it will provision usage-based object storage

Not yet implemented:
- minute-tick queue loop
- pane graph and executors
- local broker for `cued`
- local broker for desktop/CUA
- capability-lease reconciliation between hosted and on-device executors

Current executor split:
- Cloudflare Worker keeps the durable state and scheduling API
- `scripts/run-due-heartbeats.mjs` is the first external runner
- the runner reads the repo-local markdown file named by `contents`
- the runner can call Pi with a DeepSeek provider and then POST the result back to `/api/runs`
