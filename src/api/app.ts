import Fastify from "fastify";
import { z } from "zod";

import { errorMessage } from "../input.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerHeartbeatRoutes } from "./routes/heartbeats.js";
import { registerThreadRoutes } from "./routes/threads.js";

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
  registerThreadRoutes(app);
  registerHeartbeatRoutes(app);
  registerEventRoutes(app);

  return app;
}
