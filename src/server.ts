import Fastify from "fastify";

import * as db from "./db.js";
import * as worker from "./worker.js";

export function createApp() {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ ok: true, service: "threadbeat" }));

  app.post("/api/tasks", async (request, reply) => {
    try {
      const spec = request.body as Record<string, unknown>;
      if (!spec || typeof spec !== "object" || !spec.main) {
        reply.code(400);
        return { ok: false, error: "spec.main is required" };
      }
      const task = await db.createTask(spec);
      await db.appendEvent(task.id, "task_created", "api");
      return { ok: true, task };
    } catch (error) {
      reply.code(400);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.get("/api/tasks", async () => ({ ok: true, tasks: await db.listTasks() }));

  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    const task = await db.getTask(request.params.id);
    if (!task) {
      reply.code(404);
      return { ok: false, error: "task not found" };
    }
    return { ok: true, task };
  });

  app.get("/api/runs", async () => ({ ok: true, runs: await db.listRuns() }));

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (request, reply) => {
    const run = await db.getRun(request.params.id);
    if (!run) {
      reply.code(404);
      return { ok: false, error: "run not found" };
    }
    return { ok: true, run };
  });

  app.get<{
    Querystring: { taskId?: string; runId?: string; after?: string; limit?: string };
  }>("/api/events", async (request) => ({
    ok: true,
    events: await db.listEvents({
      taskId: request.query.taskId,
      runId: request.query.runId,
      after: request.query.after ? Number.parseInt(request.query.after, 10) : undefined,
      limit: request.query.limit ? Number.parseInt(request.query.limit, 10) : undefined,
    }),
  }));

  app.post<{ Body: { limit?: number } }>("/api/worker/drain-once", async (request) => ({
    ok: true,
    result: await worker.drainOnce(request.body?.limit),
  }));

  return app;
}
