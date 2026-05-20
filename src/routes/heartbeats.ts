import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { Id } from "../input.js";
import { getAgent } from "../store/agents.js";
import { createHeartbeat, deleteHeartbeat, getHeartbeat, listHeartbeats, NewHeartbeat } from "../store/heartbeats.js";

const HeartbeatsQuery = z.object({
  agentId: z.string().trim().min(1).optional(),
});

export function registerHeartbeatRoutes(app: FastifyInstance) {
  app.post("/api/heartbeats", async (request, reply) => {
    const input = NewHeartbeat.parse(request.body);
    const agent = await getAgent(input.agentId);
    if (!agent) {
      reply.code(404);
      return { ok: false, error: "agent not found" };
    }
    const heartbeat = await createHeartbeat(input);
    return { ok: true, heartbeat };
  });

  app.get<{ Querystring: { agentId?: string } }>("/api/heartbeats", async (request) => {
    const { agentId } = HeartbeatsQuery.parse(request.query);
    return { ok: true, heartbeats: await listHeartbeats(agentId) };
  });

  app.get("/api/heartbeats/:id", async (request, reply) => {
    const { id } = Id.parse(request.params);
    const heartbeat = await getHeartbeat(id);
    if (!heartbeat) {
      reply.code(404);
      return { ok: false, error: "heartbeat not found" };
    }
    return { ok: true, heartbeat };
  });

  app.delete("/api/heartbeats/:id", async (request, reply) => {
    const { id } = Id.parse(request.params);
    const heartbeat = await deleteHeartbeat(id);
    if (!heartbeat) {
      reply.code(404);
      return { ok: false, error: "heartbeat not found" };
    }
    return { ok: true, heartbeat };
  });
}
