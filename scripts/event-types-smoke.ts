import assert from "node:assert/strict";

import { eventTypeValues } from "../drizzle/schema.js";
import { close } from "../src/db/client.js";
import { appendEvent } from "../src/db/events.js";
import { createApp } from "../src/api/app.js";

const app = createApp();

try {
  const createThread = await app.inject({
    method: "POST",
    url: "/api/threads",
    payload: {
      title: "event types smoke",
      goalJson: { text: "cover every declared thread event type" },
    },
  });
  assert.equal(createThread.statusCode, 200, createThread.body);
  const threadId = createThread.json<{ thread: { id: string } }>().thread.id;

  for (const type of eventTypeValues) {
    await appendEvent(threadId, type, `event-types-smoke:${type}`, {
      eventType: type,
      marker: "event-types-ok",
    });
  }

  const eventsResponse = await app.inject({ method: "GET", url: `/api/events?threadId=${threadId}&limit=100` });
  assert.equal(eventsResponse.statusCode, 200, eventsResponse.body);
  const events = eventsResponse.json<{ events: Array<{ seq: number; threadId: string; type: string; source: string; data?: { marker?: string } }> }>().events;
  const coveredEvents = events.filter((event) => (
    event.source.startsWith("event-types-smoke:") && event.data?.marker === "event-types-ok"
  ));
  const types = coveredEvents.map((event) => event.type);

  assert.deepEqual(new Set(types), new Set(eventTypeValues));
  assert.equal(coveredEvents.length, eventTypeValues.length);
  assert.ok(coveredEvents.every((event) => event.threadId === threadId));
  assert.deepEqual([...coveredEvents].sort((a, b) => a.seq - b.seq), coveredEvents);

  const afterResponse = await app.inject({
    method: "GET",
    url: `/api/events?threadId=${threadId}&after=${coveredEvents[0]?.seq}&limit=500`,
  });
  assert.equal(afterResponse.statusCode, 200, afterResponse.body);
  const afterEvents = afterResponse.json<{ events: Array<{ source: string; data?: { marker?: string } }> }>().events;
  const coveredAfterEvents = afterEvents.filter((event) => (
    event.source.startsWith("event-types-smoke:") && event.data?.marker === "event-types-ok"
  ));
  assert.equal(coveredAfterEvents.length, eventTypeValues.length - 1);

  console.log(JSON.stringify({
    ok: true,
    threadId,
    eventTypeCount: eventTypeValues.length,
    coveredEventTypes: types,
  }, null, 2));
} finally {
  await app.close();
  await close();
}
