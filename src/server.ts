import Fastify from "fastify";

import { eventType } from "../drizzle/schema.js";
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
      await db.appendEvent(task.id, eventType.taskCreated, "api", { spec });
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

  app.get<{
    Querystring: { taskId?: string; after?: string; limit?: string };
  }>("/api/events", async (request, reply) => {
    try {
      return {
        ok: true,
        events: await db.listEvents({
          taskId: request.query.taskId,
          after: queryInteger(request.query.after, "after"),
          limit: queryInteger(request.query.limit, "limit"),
        }),
      };
    } catch (error) {
      reply.code(400);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post<{ Body: { limit?: number } }>("/api/worker/drain-once", async (request) => ({
    ok: true,
    result: await worker.drainOnce(request.body?.limit),
  }));

  return app;
}

function queryInteger(value: string | undefined, name: string) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
  const number = Number(value);
  return number;
}
