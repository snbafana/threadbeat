import assert from "node:assert/strict";

const BASE = process.env.THREADBEAT_API_URL ?? process.env.THREADBEAT_URL ?? "http://127.0.0.1:8000";

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json();
  return { status: response.status, json };
}

async function testHealth() {
  const { status, json } = await api("GET", "/health");
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  console.log("  health: ok");
}

async function testTaskLifecycle() {
  const { status, json } = await api("POST", "/api/tasks", {
    main: { cmd: "echo hello" },
  });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  const taskId = json.task.id as string;
  assert.ok(taskId);

  const get = await api("GET", `/api/tasks/${taskId}`);
  assert.equal(get.json.task.status, "queued");

  const list = await api("GET", "/api/tasks");
  assert.ok(list.json.tasks.some((t: { id: string }) => t.id === taskId));

  console.log(`  task lifecycle: ok (${taskId})`);
  return taskId;
}

async function testDrainAndEvents(taskId: string) {
  const drain = await api("POST", "/api/worker/drain-once", {});
  assert.equal(drain.status, 200);
  assert.ok(drain.json.result.processed >= 1);

  const task = await api("GET", `/api/tasks/${taskId}`);
  assert.ok(["succeeded", "failed"].includes(task.json.task.status), `unexpected status: ${task.json.task.status}`);

  const events = await api("GET", `/api/events?taskId=${taskId}`);
  assert.ok(events.json.events.length > 0, "expected at least one event");

  const types = events.json.events.map((e: { type: string }) => e.type);
  assert.ok(types.includes("task.created"));
  assert.ok(types.includes("task.started"));

  console.log(`  drain + events: ok (${events.json.events.length} events, task ${task.json.task.status})`);
}

async function testBadRequest() {
  const { status, json } = await api("POST", "/api/tasks", { noMain: true });
  assert.equal(status, 400);
  assert.equal(json.ok, false);
  console.log("  bad request: ok");
}

async function testNotFound() {
  const { status } = await api("GET", "/api/tasks/nonexistent");
  assert.equal(status, 404);
  console.log("  not found: ok");
}

console.log(`smoke tests against ${BASE}`);
await testHealth();
const taskId = await testTaskLifecycle();
await testDrainAndEvents(taskId);
await testBadRequest();
await testNotFound();
console.log("all smoke tests passed");
