import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";

import { ContentsLoader } from "./contents.js";
import { Database } from "./db.js";
import { HeartbeatExecutor } from "./executor.js";
import { RuntimeMessageBus, type RuntimeMessageEvent } from "./messageBus.js";
import { PiSharedSessionRuntime, type RuntimeLifecycleEvent } from "./piRuntime.js";
import { Scheduler } from "./scheduler.js";
import type { Settings } from "./config.js";
import {
  parseContentsPath,
  parseHeartbeatStatus,
  parsePositiveInt,
  parseRunStatus,
  parseString,
} from "./validation.js";

type AppParts = {
  app: FastifyInstance;
  db: Database;
  scheduler: Scheduler;
  runtime: PiSharedSessionRuntime;
};

export const buildServer = async (settings: Settings): Promise<AppParts> => {
  const db = new Database(
    settings.dbUrl,
    path.join(settings.projectRoot, "schema", "bootstrap.sql"),
    settings.dbAuthToken,
  );
  await db.initSchema();

  const contents = new ContentsLoader(settings.repoRoot);
  const runtime = new PiSharedSessionRuntime(settings, async (event: RuntimeLifecycleEvent) => {
    await db.createEvent({
      heartbeatId: event.heartbeatId,
      source: "runtime",
      type: event.type,
      message: event.message,
      data: event.data,
    });
  });
  await runtime.start();
  const messageBus = new RuntimeMessageBus();
  const executor = new HeartbeatExecutor(db, contents, runtime);
  const scheduler = new Scheduler(
    db,
    executor,
    settings.pollSeconds,
    settings.maxDuePerPoll,
  );

  const app = Fastify({ logger: settings.logRequests });

  app.addHook("onClose", async () => {
    scheduler.stop();
    await runtime.stop();
    await db.close();
  });

  app.get("/health", async () => ({
    ok: true,
    name: "threadbeat",
    dbUrl: settings.dbUrl.startsWith("file:") ? settings.dbUrl : "remote",
    repoRoot: settings.repoRoot,
    scheduler: {
      pollSeconds: settings.pollSeconds,
      maxDuePerPoll: settings.maxDuePerPoll,
    },
    runtime: runtime.status(),
  }));

  app.get("/api/sessions", async () => ({
    ok: true,
    sessions: await db.listSessions(),
  }));

  app.post("/api/sessions", async (request, reply) => {
    try {
      const body = request.body as Record<string, unknown>;
      const session = await db.createSession(parseString(body?.name, "name"));
      return { ok: true, session };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.get("/api/heartbeats", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return {
      ok: true,
      heartbeats: await db.listHeartbeats(query.sessionId),
    };
  });

  app.get("/api/heartbeats/due", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const limit = query.limit ? Number.parseInt(query.limit, 10) : settings.maxDuePerPoll;
    return {
      ok: true,
      heartbeats: await db.listDueHeartbeats(Number.isFinite(limit) ? limit : settings.maxDuePerPoll),
    };
  });

  app.get("/api/heartbeats/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const heartbeat = await db.getHeartbeat(id);
    if (!heartbeat) return reply.code(404).send({ ok: false, error: "heartbeat not found" });
    return { ok: true, heartbeat };
  });

  app.post("/api/heartbeats", async (request, reply) => {
    try {
      const body = request.body as Record<string, unknown>;
      const sessionId = parseString(body?.sessionId ?? body?.session_id, "sessionId");
      const session = await db.getSession(sessionId);
      if (!session) return reply.code(404).send({ ok: false, error: "session not found" });
      const heartbeat = await db.createHeartbeat({
        sessionId,
        title: body?.title === undefined ? "heartbeat" : parseString(body.title, "title"),
        cadence: parsePositiveInt(body?.cadence, "cadence", 60),
        contents: parseContentsPath(body?.contents),
        provider:
          body?.provider === undefined ? settings.piProvider : parseString(body.provider, "provider"),
        model: body?.model === undefined ? settings.piModel : parseString(body.model, "model"),
        status: parseHeartbeatStatus(body?.status, "active"),
      });
      return { ok: true, heartbeat };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.patch("/api/heartbeats/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const current = await db.getHeartbeat(id);
      if (!current) return reply.code(404).send({ ok: false, error: "heartbeat not found" });
      const body = request.body as Record<string, unknown>;
      const heartbeat = await db.updateHeartbeat(id, {
        title: body?.title === undefined ? current.title : parseString(body.title, "title"),
        cadence:
          body?.cadence === undefined
            ? current.cadence
            : parsePositiveInt(body.cadence, "cadence"),
        contents:
          body?.contents === undefined ? current.contents : parseContentsPath(body.contents),
        provider:
          body?.provider === undefined ? current.provider : parseString(body.provider, "provider"),
        model: body?.model === undefined ? current.model : parseString(body.model, "model"),
        status: parseHeartbeatStatus(body?.status, current.status),
      });
      return { ok: true, heartbeat };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/heartbeats/:id/pause", async (request, reply) => {
    const { id } = request.params as { id: string };
    const current = await db.getHeartbeat(id);
    if (!current) return reply.code(404).send({ ok: false, error: "heartbeat not found" });
    const heartbeat = await db.updateHeartbeat(id, {
      title: current.title,
      cadence: current.cadence,
      contents: current.contents,
      provider: current.provider,
      model: current.model,
      status: "inactive",
    });
    return { ok: true, heartbeat };
  });

  app.post("/api/heartbeats/:id/resume", async (request, reply) => {
    const { id } = request.params as { id: string };
    const current = await db.getHeartbeat(id);
    if (!current) return reply.code(404).send({ ok: false, error: "heartbeat not found" });
    const heartbeat = await db.updateHeartbeat(id, {
      title: current.title,
      cadence: current.cadence,
      contents: current.contents,
      provider: current.provider,
      model: current.model,
      status: "active",
    });
    return { ok: true, heartbeat };
  });

  app.post("/api/heartbeats/:id/run-now", async (request, reply) => {
    const { id } = request.params as { id: string };
    const heartbeat = await db.getHeartbeat(id);
    if (!heartbeat) return reply.code(404).send({ ok: false, error: "heartbeat not found" });
    await db.createEvent({
      heartbeatId: heartbeat.id,
      sessionId: heartbeat.session_id,
      source: "api",
      type: "heartbeat_run_now_requested",
      message: "Manual heartbeat run requested",
    });
    const run = await executor.execute(heartbeat);
    return { ok: true, run, heartbeat: await db.getHeartbeat(id) };
  });

  app.post("/api/heartbeats/:id/tick", async (request, reply) => {
    const { id } = request.params as { id: string };
    const heartbeat = await db.tickHeartbeat(id);
    if (!heartbeat) return reply.code(404).send({ ok: false, error: "heartbeat not found" });
    return { ok: true, heartbeat };
  });

  app.get("/api/runs", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return {
      ok: true,
      runs: await db.listRuns({
        heartbeatId: query.heartbeatId,
        sessionId: query.sessionId,
      }),
    };
  });

  app.get("/api/events", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const limit = query.limit ? Number.parseInt(query.limit, 10) : 100;
    return {
      ok: true,
      events: await db.listEvents({
        heartbeatId: query.heartbeatId,
        runId: query.runId,
        sessionId: query.sessionId,
        limit: Number.isFinite(limit) ? limit : 100,
      }),
    };
  });

  app.post("/api/runs", async (request, reply) => {
    try {
      const body = request.body as Record<string, unknown>;
      const heartbeatId = parseString(body?.heartbeatId ?? body?.heartbeat_id, "heartbeatId");
      const heartbeat = await db.getHeartbeat(heartbeatId);
      if (!heartbeat) return reply.code(404).send({ ok: false, error: "heartbeat not found" });
      const run = await db.createRun({
        heartbeatId,
        sessionId: heartbeat.session_id,
        executor: parseString(body?.executor, "executor"),
        model: body?.model === undefined ? null : parseString(body.model, "model"),
        status: parseRunStatus(body?.status),
        promptSnapshot: parseString(body?.promptSnapshot ?? body?.prompt_snapshot, "promptSnapshot"),
        output: body?.output === undefined ? null : parseString(body.output, "output"),
        error: body?.error === undefined ? null : parseString(body.error, "error"),
      });
      return { ok: true, run };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.get("/api/runtime/pi", async () => ({
    ok: true,
    runtime: runtime.status(),
  }));

  app.post("/api/runtime/pi/reset", async () => {
    await runtime.reset();
    return { ok: true, runtime: runtime.status() };
  });

  app.get("/api/runtime/pi/messages/listen", async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const limit = query.limit ? Number.parseInt(query.limit, 10) : null;
    let count = 0;
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    });

    const write = (payload: RuntimeMessageEvent): void => {
      reply.raw.write(`${JSON.stringify(payload)}\n`);
      count += 1;
      if (limit !== null && Number.isFinite(limit) && count >= limit) {
        unsubscribe();
        reply.raw.end();
      }
    };
    const unsubscribe = messageBus.subscribe(write);
    request.raw.on("close", unsubscribe);
  });

  app.post("/api/runtime/pi/message/stream", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const message = parseString(body?.message, "message");
    const messageId = randomId("msg");

    reply.raw.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    });

    const write = (payload: Record<string, unknown>): void => {
      reply.raw.write(`${JSON.stringify(payload)}\n`);
    };

    const startedAt = new Date().toISOString();
    messageBus.publish({ type: "message_started", messageId, input: message, startedAt });
    write({ type: "start", messageId, runtime: runtime.status() });
    try {
      const text = await runtime.streamMessage(message, (delta) => {
        const event = { type: "message_delta" as const, messageId, text: delta };
        messageBus.publish(event);
        write({ type: "delta", messageId, text: delta });
      });
      const completedAt = new Date().toISOString();
      messageBus.publish({ type: "message_done", messageId, text, completedAt });
      write({ type: "done", messageId, text, runtime: runtime.status() });
    } catch (error) {
      const completedAt = new Date().toISOString();
      const errorMessage = messageOf(error);
      messageBus.publish({ type: "message_error", messageId, error: errorMessage, completedAt });
      write({ type: "error", messageId, error: errorMessage, runtime: runtime.status() });
    } finally {
      reply.raw.end();
    }
  });

  app.post("/api/scheduler/run-once", async () => ({
    ok: true,
    processed: await scheduler.runOnce(),
  }));

  scheduler.start();

  return { app, db, scheduler, runtime };
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const randomId = (prefix: string): string => `${prefix}_${randomUUID().replaceAll("-", "")}`;
