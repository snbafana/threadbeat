import assert from "node:assert/strict";

import { eventType, eventTypeValues, taskStatus } from "../drizzle/schema.js";
import { close } from "../src/db/client.js";
import { appendEvent } from "../src/db/events.js";
import { createApp } from "../src/api/app.js";
import { updateTaskStatus } from "../src/db/tasks.js";
import { assertTaskEventStream, type TaskEvent } from "./smoke-helpers.js";

const app = createApp();

try {
  const create = await app.inject({
    method: "POST",
    url: "/api/tasks",
    payload: {
      main: {
        cmd: "echo event-types-smoke",
      },
    },
  });
  assert.equal(create.statusCode, 200, create.body);
  const taskId = create.json<{ task: { id: string } }>().task.id;
  await updateTaskStatus(taskId, taskStatus.succeeded);

  for (const type of eventTypeValues) {
    if (type === eventType.taskCreated) continue;
    await appendEvent(taskId, type, `event-types-smoke:${type}`, {
      eventType: type,
      marker: "event-types-ok",
    });
  }

  const eventsResponse = await app.inject({ method: "GET", url: `/api/events?taskId=${taskId}&limit=100` });
  assert.equal(eventsResponse.statusCode, 200, eventsResponse.body);
  const streamedEvents = eventsResponse.json<{ events: TaskEvent[] }>().events;
  const types = assertTaskEventStream(streamedEvents, [...eventTypeValues]);

  assert.deepEqual(new Set(types), new Set(eventTypeValues));
  assert.equal(streamedEvents.length, eventTypeValues.length);

  const afterResponse = await app.inject({
    method: "GET",
    url: `/api/events?taskId=${taskId}&after=${streamedEvents[0]?.seq}&limit=500`,
  });
  assert.equal(afterResponse.statusCode, 200, afterResponse.body);
  const afterEvents = afterResponse.json<{ events: TaskEvent[] }>().events;
  assert.equal(afterEvents.length, eventTypeValues.length - 1);
  assert.equal(afterEvents.some((event) => event.type === eventType.taskCreated), false);

  console.log(JSON.stringify({
    ok: true,
    taskId,
    eventTypeCount: eventTypeValues.length,
    coveredEventTypes: types,
  }, null, 2));
} finally {
  await app.close();
  await close();
}
