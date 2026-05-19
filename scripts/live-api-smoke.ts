import assert from "node:assert/strict";

import { loadSettings } from "../src/config.js";
import { DaytonaSandboxProvider } from "../src/daytonaProvider.js";
import { MemoryTaskRepository } from "../src/db.js";
import { createApp } from "../src/server.js";

const settings = {
  ...loadSettings(),
  maxSandboxes: 1,
  commandTimeoutSeconds: 60,
  sandboxEnvAllowlist: ["THREADBEAT_SMOKE_MARKER"],
};

const repository = new MemoryTaskRepository();
const { app } = createApp(settings, repository, new DaytonaSandboxProvider(settings));

try {
  const create = await app.inject({
    method: "POST",
    url: "/api/tasks",
    payload: {
      repo: { url: "https://github.com/octocat/Hello-World.git", branch: "master" },
      main: { cmd: "ls -la && (test -f README || test -f README.md)", timeoutSeconds: 60 },
      verify: [{ cmd: "echo $THREADBEAT_SMOKE_MARKER", timeoutSeconds: 30 }],
    },
  });
  assert.equal(create.statusCode, 200, create.body);
  const taskId = create.json().task.id as string;

  const drain = await app.inject({ method: "POST", url: "/api/worker/drain-once", payload: {} });
  assert.equal(drain.statusCode, 200, drain.body);

  const task = await app.inject({ method: "GET", url: `/api/tasks/${taskId}` });
  assert.equal(task.json().task.status, "succeeded", task.body);

  const events = await app.inject({ method: "GET", url: `/api/events?taskId=${taskId}&limit=100` });
  const eventRows = events.json().events as Array<{ type: string }>;
  assert.ok(eventRows.some((event) => event.type === "sandbox_deleted"));

  console.log(JSON.stringify({ ok: true, taskId, events: eventRows.length }, null, 2));
} finally {
  await app.close();
}
