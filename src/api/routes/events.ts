import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { listEvents } from "../../db/events.js";

const EventsQuery = z.object({
  taskId: z.string().trim().min(1).optional(),
  after: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().optional(),
});

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
