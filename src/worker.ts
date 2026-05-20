import { maxSandboxes } from "./config.js";
import { runTask } from "./runTask.js";
import { claimNextTask } from "./store/tasks.js";

export async function drainOnce(limit = maxSandboxes) {
  const processed: string[] = [];
  const count = Math.max(1, Math.min(limit, maxSandboxes));
  for (let i = 0; i < count; i++) {
    const task = await claimNextTask();
    if (!task) break;
    await runTask(task);
    processed.push(task.id);
  }
  return { processed: processed.length, taskIds: processed };
}
