import assert from "node:assert/strict";

import { close } from "../src/db.js";
import { createApp } from "../src/server.js";
import {
  assertTaskEventStream,
  installSamplePiRepoCommand,
  materializeSamplePiRepoCommand,
  piFixture,
  piInjectionCheckCommand,
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
        cmd: piInjectionCheckCommand(),
        cwd: samplePiRepoPath,
        timeoutSeconds: 120,
      },
      verify: [
        {
          cmd: "test -f pi-models.json && test -d node_modules/@mariozechner/pi-coding-agent",
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
  const types = assertTaskEventStream(events, [
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
  assert.match(stdout, /pi-auth-ok/);

  console.log(JSON.stringify({
    ok: true,
    taskId,
    taskStatus: task.status,
    eventCount: events.length,
    eventTypes: types,
    sawPiAuth: true,
  }, null, 2));
} finally {
  await app.close();
  await close();
}
