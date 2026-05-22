import { workerConcurrency, workerPollMs } from "../config.js";
import { drainDueHeartbeats } from "../db/heartbeats.js";

let draining: Promise<void> | undefined;
let autoDrain = false;

export function startWorkerLoop() {
  autoDrain = true;

  const timer = setInterval(() => scheduleDrain(), workerPollMs);
  scheduleDrain();

  return async function stopWorkerLoop() {
    autoDrain = false;
    clearInterval(timer);
    await draining;
  };
}

export async function drainOnce(limit = workerConcurrency) {
  const count = Math.max(1, Math.min(limit, workerConcurrency));
  const heartbeats = await drainDueHeartbeats(count);
  return { processed: heartbeats.processed, heartbeats };
}

function scheduleDrain() {
  if (!autoDrain || draining) return;
  draining = drainDueHeartbeats(workerConcurrency).then(() => undefined)
    .catch((error) => {
      console.error("worker heartbeat drain failed", error);
    })
    .finally(() => {
      draining = undefined;
    });
}
