import { workerConcurrency, workerPollMs } from "../config.js";
import { runTask } from "../agent/run.js";
import { claimNextTask } from "../db/tasks.js";

const active = new Set<Promise<void>>();
let filling: Promise<void> | undefined;
let claiming = 0;
let autoFill = false;

export function startWorkerLoop() {
  autoFill = true;

  const timer = setInterval(() => scheduleFill(), workerPollMs);
  scheduleFill();

  return async function stopWorkerLoop() {
    autoFill = false;
    clearInterval(timer);
    await filling;
    await Promise.allSettled(active);
  };
}

export async function drainOnce(limit = workerConcurrency) {
  const started: Array<{ id: string; run: Promise<void> }> = [];
  const count = Math.max(1, Math.min(limit, workerConcurrency));
  for (let i = 0; i < count; i++) {
    const task = await claimAndStart();
    if (!task) break;
    started.push(task);
  }
  await Promise.allSettled(started.map((task) => task.run));
  return { processed: started.length, taskIds: started.map((task) => task.id) };
}

function scheduleFill() {
  if (!autoFill || filling) return;
  filling = fillSlots()
    .catch((error) => {
      console.error("worker fill failed", error);
    })
    .finally(() => {
      filling = undefined;
    });
}

async function fillSlots() {
  while (autoFill) {
    const task = await claimAndStart();
    if (!task) return;
  }
}

async function claimAndStart() {
  if (active.size + claiming >= workerConcurrency) return null;

  claiming += 1;
  const task = await claimNextTask().finally(() => {
    claiming -= 1;
  });
  if (!task) return null;

  const run = runTask(task)
    .catch((error) => {
      console.error(`worker task ${task.id} failed`, error);
    })
    .finally(() => {
      active.delete(run);
      scheduleFill();
    });
  active.add(run);
  return { id: task.id, run };
}
