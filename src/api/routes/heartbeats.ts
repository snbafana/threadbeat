import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { Id } from "../../input.js";
import { drainDueHeartbeats, getHeartbeat, listHeartbeats } from "../../db/heartbeats.js";

const DrainDue = z.object({
  limit: z.number().int().positive().optional(),
});

export function registerHeartbeatRoutes(app: FastifyInstance) {
  app.get("/api/heartbeats", async () => ({ ok: true, heartbeats: await listHeartbeats() }));

  app.get("/api/heartbeats/:id", async (request, reply) => {
    const { id } = Id.parse(request.params);
    const heartbeat = await getHeartbeat(id);
    if (!heartbeat) {
      reply.code(404);
      return { ok: false, error: "heartbeat not found" };
    }
    return { ok: true, heartbeat };
  });

  app.post("/api/heartbeats/drain-due", async (request) => {
    const { limit } = DrainDue.parse(request.body ?? {});
    return { ok: true, result: await drainDueHeartbeats(limit) };
  });
}
