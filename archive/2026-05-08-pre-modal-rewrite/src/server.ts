import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";

import { ContentsLoader } from "./contents.js";
import { Database, type HeartbeatUpdateInput } from "./db.js";
import { HeartbeatExecutor } from "./executor.js";
import { RuntimeMessageBus, type RuntimeMessageEvent } from "./messageBus.js";
import { PiSharedSessionRuntime, type RuntimeLifecycleEvent } from "./piRuntime.js";
import { Scheduler } from "./scheduler.js";
import { nowIso } from "./time.js";
import type { Settings } from "./config.js";
import type { HeartbeatRow, HeartbeatStatus } from "./types.js";
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
  const messageBus = new RuntimeMessageBus();
  const executor = new HeartbeatExecutor(db, contents, runtime, (event) => {
    messageBus.publish(event);
  });
  const scheduler = new Scheduler(
    db,
    executor,
    settings.pollSeconds,
    settings.maxDuePerPoll,
  );

  const app = Fastify({ logger: settings.logRequests });

  void runtime.start().catch(async (error: unknown) => {
    const message = messageOf(error);
    app.log.error({ err: error }, "Pi runtime failed to start in background");
    await recordBackgroundFailure(db, "runtime", "runtime_start_failed", message);
  });

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
      ...scheduler.status(),
    },
    runtime: runtime.status(),
  }));

  app.get("/api/sessions", async () => ({
    ok: true,
    sessions: await db.listSessions(),
  }));

  app.post("/api/sessions", async (request, reply) => {
    try {
      const body = requestBody(request.body);
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
    return {
      ok: true,
      heartbeats: await db.listDueHeartbeats(parseLimit(query.limit, settings.maxDuePerPoll)),
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
      const body = requestBody(request.body);
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
      const heartbeat = await db.updateHeartbeat(id, heartbeatUpdateFromBody(current, requestBody(request.body)));
      return { ok: true, heartbeat };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/heartbeats/:id/pause", async (request, reply) => {
    const { id } = request.params as { id: string };
    const current = await db.getHeartbeat(id);
    if (!current) return reply.code(404).send({ ok: false, error: "heartbeat not found" });
    const heartbeat = await updateHeartbeatStatus(db, current, "inactive");
    return { ok: true, heartbeat };
  });

  app.post("/api/heartbeats/:id/resume", async (request, reply) => {
    const { id } = request.params as { id: string };
    const current = await db.getHeartbeat(id);
    if (!current) return reply.code(404).send({ ok: false, error: "heartbeat not found" });
    const heartbeat = await updateHeartbeatStatus(db, current, "active");
    return { ok: true, heartbeat };
  });

  app.post("/api/heartbeats/:id/run-now", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = requestBody(request.body);
    const preserveCadence = parseBoolean(body.preserveCadence ?? body.preserve_cadence, false);
    const heartbeat = await db.getHeartbeat(id);
    if (!heartbeat) return reply.code(404).send({ ok: false, error: "heartbeat not found" });
    await db.createEvent({
      heartbeatId: heartbeat.id,
      sessionId: heartbeat.session_id,
      source: "api",
      type: "heartbeat_run_now_requested",
      message: "Manual heartbeat run requested",
      data: { preserveCadence },
    });
    const run = await executor.execute(heartbeat, { reschedule: !preserveCadence });
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
    return {
      ok: true,
      events: await db.listEvents({
        heartbeatId: query.heartbeatId,
        runId: query.runId,
        sessionId: query.sessionId,
        limit: parseLimit(query.limit, 100),
      }),
    };
  });

  app.post("/api/runs", async (request, reply) => {
    try {
      const body = requestBody(request.body);
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
    const limit = query.limit ? parseLimit(query.limit, Number.POSITIVE_INFINITY) : null;
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
    const body = requestBody(request.body);
    const message = parseString(body?.message, "message");
    const memoryMode = parseMemoryMode(body?.memoryMode ?? body?.memory_mode);
    const messageId = randomId("msg");

    reply.raw.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    });

    const write = (payload: Record<string, unknown>): void => {
      reply.raw.write(`${JSON.stringify(payload)}\n`);
    };

    const startedAt = nowIso();
    messageBus.publish({
      type: "message_started",
      messageId,
      input: message,
      startedAt,
      source: "interactive",
    });
    write({ type: "start", messageId, memoryMode, runtime: runtime.status() });
    try {
      const text = await runtime.streamMessage(message, (delta) => {
        const event = {
          type: "message_delta" as const,
          messageId,
          text: delta,
          source: "interactive" as const,
        };
        messageBus.publish(event);
        write({ type: "delta", messageId, text: delta });
      }, memoryMode);
      const completedAt = nowIso();
      messageBus.publish({
        type: "message_done",
        messageId,
        text,
        completedAt,
        source: "interactive",
      });
      write({ type: "done", messageId, text, runtime: runtime.status() });
    } catch (error) {
      const completedAt = nowIso();
      const errorMessage = messageOf(error);
      messageBus.publish({
        type: "message_error",
        messageId,
        error: errorMessage,
        completedAt,
        source: "interactive",
      });
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

const recordBackgroundFailure = async (
  db: Database,
  source: string,
  type: string,
  message: string,
): Promise<void> => {
  try {
    await db.createEvent({ source, type, message });
  } catch {
    // Do not let observability failures crash the control plane.
  }
};

const requestBody = (body: unknown): Record<string, unknown> => {
  if (typeof body === "object" && body !== null && !Array.isArray(body)) return body as Record<string, unknown>;
  return {};
};

const parseLimit = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const heartbeatUpdateFromBody = (
  current: HeartbeatRow,
  body: Record<string, unknown>,
): HeartbeatUpdateInput => ({
  title: body.title === undefined ? current.title : parseString(body.title, "title"),
  cadence: body.cadence === undefined ? current.cadence : parsePositiveInt(body.cadence, "cadence"),
  contents: body.contents === undefined ? current.contents : parseContentsPath(body.contents),
  provider: body.provider === undefined ? current.provider : parseString(body.provider, "provider"),
  model: body.model === undefined ? current.model : parseString(body.model, "model"),
  status: parseHeartbeatStatus(body.status, current.status),
});

const updateHeartbeatStatus = (
  db: Database,
  heartbeat: HeartbeatRow,
  status: HeartbeatStatus,
): Promise<HeartbeatRow | null> =>
  db.updateHeartbeat(heartbeat.id, {
    title: heartbeat.title,
    cadence: heartbeat.cadence,
    contents: heartbeat.contents,
    provider: heartbeat.provider,
    model: heartbeat.model,
    status,
  });

const parseMemoryMode = (value: unknown): "shared" | "stateless" => {
  if (value === undefined) return "shared";
  if (value === "shared" || value === "stateless") return value;
  throw new Error("memoryMode must be shared or stateless");
};

const parseBoolean = (value: unknown, fallback: boolean): boolean => {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};
