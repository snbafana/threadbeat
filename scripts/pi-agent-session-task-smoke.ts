import assert from "node:assert/strict";

import * as db from "../src/db.js";
import { createApp } from "../src/server.js";
import {
  assertTaskEventStream,
  installSamplePiRepoCommand,
  materializeSamplePiRepoCommand,
  piFixture,
  requireDeepseekKey,
  samplePiRepoPath,
  stdoutFromEvents,
  type TaskEvent,
} from "./smoke-helpers.js";

requireDeepseekKey();

const app = createApp();

try {
  const create = await app.inject({
    method: "POST",
    url: "/api/tasks",
    payload: {
      repo: { url: piFixture.repoUrl, branch: piFixture.branch },
      setup: [
        {
          cmd: [
            "git rev-parse --is-inside-work-tree",
            "test -f package.json",
            "test -d src",
            materializeSamplePiRepoCommand(),
            installSamplePiRepoCommand(),
          ].join(" && "),
          timeoutSeconds: 300,
        },
      ],
      main: {
        cmd: piAgentSessionCommand(),
        cwd: samplePiRepoPath,
        timeoutSeconds: 240,
      },
      verify: [
        {
          cmd: "test -f .threadbeat-pi-agent-session-output.txt && grep -q pi-agent-session-ok .threadbeat-pi-agent-session-output.txt",
          cwd: samplePiRepoPath,
          timeoutSeconds: 30,
        },
      ],
    },
  });
  assert.equal(create.statusCode, 200, create.body);
  const taskId = create.json<{ task: { id: string } }>().task.id;

  const drain = await app.inject({ method: "POST", url: "/api/worker/drain-once", payload: {} });
  assert.equal(drain.statusCode, 200, drain.body);
  assert.equal(drain.json<{ result: { processed: number } }>().result.processed, 1);

  const taskResponse = await app.inject({ method: "GET", url: `/api/tasks/${taskId}` });
  assert.equal(taskResponse.statusCode, 200, taskResponse.body);
  const task = taskResponse.json<{ task: { status: string; error?: string } }>().task;
  assert.equal(task.status, "succeeded", task.error ?? JSON.stringify(task));

  const eventsResponse = await app.inject({ method: "GET", url: `/api/events?taskId=${taskId}&limit=100` });
  assert.equal(eventsResponse.statusCode, 200, eventsResponse.body);
  const events = eventsResponse.json<{ events: TaskEvent[] }>().events;
  assertTaskEventStream(events, [
    "task.created",
    "task.started",
    "sandbox.created",
    "repo.cloned",
    "command.started",
    "command.stdout",
    "command.completed",
    "task.completed",
    "sandbox.deleted",
  ]);
  const stdout = stdoutFromEvents(events);

  assert.match(stdout, /pi-agent-session-ok/);

  console.log(JSON.stringify({
    ok: true,
    taskId,
    taskStatus: task.status,
    eventCount: events.length,
    sawPiAgentSession: true,
  }, null, 2));
} finally {
  await app.close();
  await db.close();
}

function piAgentSessionCommand() {
  return String.raw`cat > .threadbeat-pi-agent-session-check.mjs <<'EOF'
import {
  AuthStorage,
  createAgentSession,
  createReadOnlyTools,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import path from "node:path";

if (!process.env.DEEPSEEK_API_KEY) throw new Error("missing DEEPSEEK_API_KEY");

const authStorage = AuthStorage.create();
authStorage.setRuntimeApiKey("deepseek", process.env.DEEPSEEK_API_KEY);
const modelRegistry = new ModelRegistry(authStorage, path.join(process.cwd(), "pi-models.json"));
const model = modelRegistry.find("deepseek", "deepseek-v4-flash");
if (!model) throw new Error("deepseek-v4-flash not resolved");

const { session } = await createAgentSession({
  cwd: process.cwd(),
  authStorage,
  modelRegistry,
  model,
  thinkingLevel: "off",
  tools: createReadOnlyTools(process.cwd()),
  sessionManager: SessionManager.create(process.cwd()),
});

try {
  await session.prompt("Reply with exactly this marker and no other words: pi-agent-session-ok");
  const text = session.getLastAssistantText() ?? "";
  if (!text.includes("pi-agent-session-ok")) {
    throw new Error("unexpected agent response: " + text.slice(0, 500));
  }
  await import("node:fs/promises").then((fs) => fs.writeFile(".threadbeat-pi-agent-session-output.txt", text));
  console.log("pi-agent-session-ok");
} finally {
  session.dispose();
}
EOF
node .threadbeat-pi-agent-session-check.mjs 2>&1`;
}
