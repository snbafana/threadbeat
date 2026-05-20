import Fastify from "fastify";

import { errorMessage } from "./input.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerWorkerRoutes } from "./routes/worker.js";

export function createApp() {
  const app = Fastify({ logger: false });

  app.setErrorHandler((error, _request, reply) => {
    reply.code(statusCode(error)).send({ ok: false, error: errorMessage(error) });
  });

  registerHealthRoutes(app);
  registerAgentRoutes(app);
  registerTaskRoutes(app);
  registerEventRoutes(app);
  registerWorkerRoutes(app);

  return app;
}

function statusCode(error: unknown) {
  if (typeof error === "object" && error && "statusCode" in error && typeof error.statusCode === "number") {
    return error.statusCode;
  }
  return 400;
}
