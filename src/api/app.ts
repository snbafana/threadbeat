import Fastify from "fastify";
import { z } from "zod";

import { errorMessage } from "../input.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerHeartbeatRoutes } from "./routes/heartbeats.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { drainOnce } from "../worker/loop.js";

const Drain = z.object({
  limit: z.number().int().positive().optional(),
});

export function createApp() {
  const app = Fastify({ logger: false });

  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof z.ZodError
      ? 400
      : typeof error === "object" && error && "statusCode" in error && typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    reply.code(status).send({ ok: false, error: errorMessage(error) });
  });

  app.get("/health", async () => ({ ok: true, service: "threadbeat" }));

  registerAgentRoutes(app);
  registerHeartbeatRoutes(app);
  registerTaskRoutes(app);
  registerEventRoutes(app);

  app.post("/api/worker/drain-once", async (request) => {
    const { limit } = Drain.parse(request.body ?? {});
    return {
      ok: true,
      result: await drainOnce(limit),
    };
  });

  return app;
}
