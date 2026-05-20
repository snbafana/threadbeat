import type { FastifyInstance } from "fastify";

import { eventType } from "../../drizzle/schema.js";
import { CommandTask, Id } from "../input.js";
import { appendEvent } from "../store/events.js";
import { createTask, getTask, listTasks } from "../store/tasks.js";

export function registerTaskRoutes(app: FastifyInstance) {
  app.post("/api/tasks", async (request) => {
    const taskSpec = CommandTask.parse(request.body);
    const task = await createTask(taskSpec);
    await appendEvent(task.id, eventType.taskCreated, "api", { spec: taskSpec });
    return { ok: true, task };
  });

  app.get("/api/tasks", async () => ({ ok: true, tasks: await listTasks() }));

  app.get<{ Params: Id }>("/api/tasks/:id", async (request, reply) => {
    const { id } = Id.parse(request.params);
    const task = await getTask(id);
    if (!task) {
      reply.code(404);
      return { ok: false, error: "task not found" };
    }
    return { ok: true, task };
  });
}
