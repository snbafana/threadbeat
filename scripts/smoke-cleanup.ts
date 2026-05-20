import * as db from "../src/db.js";
import { taskStatus } from "../drizzle/schema.js";

const smokeMarkers = [
  "event-types-smoke",
  "pi-auth-ok",
  "pi-agent-session-ok",
  "github-remote-ok",
  "finance-graphs-ok",
  "sample-pi-repo-created",
];

try {
  const tasks = await db.listTasks();
  const stale = tasks.filter((task) => (
    task.status === taskStatus.queued &&
    smokeMarkers.some((marker) => JSON.stringify(task.spec).includes(marker))
  ));

  for (const task of stale) {
    await db.updateTaskStatus(task.id, taskStatus.failed, "stale smoke task cleaned before rerun");
  }

  console.log(JSON.stringify({ ok: true, cleaned: stale.length }, null, 2));
} finally {
  await db.close();
}
