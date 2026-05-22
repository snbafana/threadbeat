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

console.log(`smoke tests against ${BASE}`);

const health = await api("GET", "/health");
assert.equal(health.status, 200);
assert.equal(health.json.ok, true);
console.log("  health: ok");

const createThread = await api("POST", "/api/threads", {
  title: "http smoke thread",
  goalJson: { text: "prove message-first HTTP smoke" },
});
assert.equal(createThread.status, 200);
const threadId = createThread.json.thread.id as string;
assert.ok(threadId);
console.log(`  thread create: ok (${threadId})`);

const message = await api("POST", `/api/threads/${threadId}/messages`, {
  role: "human",
  contentJson: { text: "start this repo-backed agent from messages" },
});
assert.equal(message.status, 200);
assert.equal(message.json.message.content.text, "start this repo-backed agent from messages");
console.log("  message append: ok");

const heartbeat = await api("POST", `/api/threads/${threadId}/heartbeats`, {
  title: "http smoke heartbeat",
  cadenceSeconds: 60,
  messageJson: { text: "continue from heartbeat" },
  nextTickAt: new Date(Date.now() - 1000).toISOString(),
});
assert.equal(heartbeat.status, 200);
const heartbeatId = heartbeat.json.heartbeat.id as string;

const drain = await api("POST", "/api/heartbeats/drain-due", { limit: 20 });
assert.equal(drain.status, 200);
assert.ok(drain.json.result.messages.some((item: { heartbeatId: string }) => item.heartbeatId === heartbeatId));
console.log("  heartbeat drain: ok");

const events = await api("GET", `/api/events?threadId=${threadId}`);
assert.equal(events.status, 200);
assert.ok(events.json.events.some((event: { type: string; source: string }) => (
  event.type === "message.created" && event.source === `heartbeat:${heartbeatId}`
)));
console.log("  thread events: ok");

const badMessage = await api("POST", `/api/threads/${threadId}/messages`, {
  role: "human",
  content: "not json-only",
});
assert.equal(badMessage.status, 400);
assert.equal(badMessage.json.ok, false);
console.log("  bad request: ok");

const missing = await api("GET", "/api/threads/nonexistent");
assert.equal(missing.status, 404);
console.log("  not found: ok");

console.log("all smoke tests passed");
