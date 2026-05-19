import assert from "node:assert/strict";

const BASE = process.env.THREADBEAT_API_URL ?? process.env.THREADBEAT_URL ?? "http://127.0.0.1:8000";

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, json: await response.json() };
}

const create = await api("POST", "/api/tasks", {
  repo: { url: "https://github.com/octocat/Hello-World.git", branch: "master" },
  main: { cmd: "ls -la && (test -f README || test -f README.md)", timeoutSeconds: 60 },
  verify: [{ cmd: "echo $THREADBEAT_SMOKE_MARKER", timeoutSeconds: 30 }],
});
assert.equal(create.status, 200);
const taskId = create.json.task.id as string;

const drain = await api("POST", "/api/worker/drain-once", {});
assert.equal(drain.status, 200);

const task = await api("GET", `/api/tasks/${taskId}`);
assert.equal(task.json.task.status, "succeeded", `task failed: ${JSON.stringify(task.json.task)}`);

const events = await api("GET", `/api/events?taskId=${taskId}&limit=100`);
const types = events.json.events.map((e: { type: string }) => e.type);
assert.ok(types.includes("sandbox.deleted"));

console.log(JSON.stringify({ ok: true, taskId, events: types.length }, null, 2));
