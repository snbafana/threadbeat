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
  setup: [{ cmd: "echo setup" }],
  main: { cmd: "echo main" },
  verify: [{ cmd: "echo verify" }],
});
assert.equal(create.status, 200);
const taskId = create.json.task.id as string;

const drain = await api("POST", "/api/worker/drain-once", {});
assert.equal(drain.status, 200);
assert.equal(drain.json.result.processed, 1);

const task = await api("GET", `/api/tasks/${taskId}`);
console.log(`task status: ${task.json.task.status}`);

const events = await api("GET", `/api/events?taskId=${taskId}`);
const types = events.json.events.map((e: { type: string }) => e.type);
console.log(`events: ${types.join(", ")}`);
console.log(JSON.stringify({ ok: true, taskId, eventCount: types.length }, null, 2));
