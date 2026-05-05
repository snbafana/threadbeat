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
- D1 stores sessions and heartbeat prompt objects
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
