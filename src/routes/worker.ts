import type { FastifyInstance } from "fastify";

import { Drain } from "../input.js";
import { drainOnce } from "../worker.js";

export function registerWorkerRoutes(app: FastifyInstance) {
  app.post("/api/worker/drain-once", async (request) => {
    const { limit } = Drain.parse(request.body ?? {});
    return {
      ok: true,
      result: await drainOnce(limit),
    };
  });
}
