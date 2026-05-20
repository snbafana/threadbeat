import type { FastifyInstance } from "fastify";

import { EventsQuery } from "../input.js";
import { listEvents } from "../store/events.js";

export function registerEventRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { taskId?: string; after?: string; limit?: string };
  }>("/api/events", async (request) => {
    const query = EventsQuery.parse(request.query);
    return {
      ok: true,
      events: await listEvents(query),
    };
  });
}
