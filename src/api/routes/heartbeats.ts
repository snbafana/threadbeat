import type { FastifyInstance } from "fastify";

import { Id } from "../../input.js";
import { getHeartbeat, listHeartbeats } from "../../db/heartbeats.js";

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
}
