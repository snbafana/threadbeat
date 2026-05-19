import Fastify, { type FastifyInstance } from "fastify";

import type { Settings } from "./config.js";
import type { TaskRepository } from "./db.js";
import type { SandboxProvider } from "./sandboxProvider.js";
import { parseTaskSpec } from "./taskSpec.js";
import { TaskWorker } from "./worker.js";

export type AppContext = {
  app: FastifyInstance;
  repository: TaskRepository;
  worker: TaskWorker;
};

export const createApp = (
  settings: Settings,
  repository: TaskRepository,
  sandboxProvider: SandboxProvider,
): AppContext => {
  const app = Fastify({ logger: false });
  const worker = new TaskWorker(repository, sandboxProvider, settings);

  app.get("/health", async () => ({
    ok: true,
    service: "threadbeat",
    mode: "daytona-task-substrate",
  }));

  app.post("/api/tasks", async (request, reply) => {
    try {
      const spec = parseTaskSpec(request.body);
      const task = await repository.createTask({ spec });
      await repository.appendEvent({
        taskId: task.id,
        type: "task_created",
        source: "api",
        message: "Task created",
        data: { hasRepo: Boolean(spec.repo) },
      });
      return { ok: true, task };
    } catch (error) {
      reply.code(400);
      return { ok: false, error: errorMessage(error) };
    }
  });

  app.get("/api/tasks", async () => ({ ok: true, tasks: await repository.listTasks() }));

  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    const task = await repository.getTask(request.params.id);
    if (!task) {
      reply.code(404);
      return { ok: false, error: "task not found" };
    }
    return { ok: true, task };
  });

  app.get("/api/runs", async () => ({ ok: true, runs: await repository.listRuns() }));

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (request, reply) => {
    const run = await repository.getRun(request.params.id);
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
    events: await repository.listEvents({
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

  return { app, repository, worker };
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
