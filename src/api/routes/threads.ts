import type { FastifyInstance } from "fastify";

import { ArtifactInput, HeartbeatInput, Id, MessageInput, SandboxInput, ThreadInput } from "../../input.js";
import { createArtifact, listArtifacts } from "../../db/artifacts.js";
import { createThreadHeartbeat, listHeartbeats } from "../../db/heartbeats.js";
import { appendMessage, listMessages } from "../../db/messages.js";
import { closeSandboxRecord, createSandboxRecord, getCurrentSandboxRecord, listSandboxRecords } from "../../db/sandboxes.js";
import { createThread, getThread, listThreads } from "../../db/threads.js";

export function registerThreadRoutes(app: FastifyInstance) {
  app.post("/api/threads", async (request) => {
    const thread = await createThread(ThreadInput.parse(request.body));
    return { ok: true, thread };
  });

  app.get("/api/threads", async () => ({ ok: true, threads: await listThreads() }));

  app.get("/api/threads/:id", async (request, reply) => {
    const thread = await requireThread(Id.parse(request.params).id, reply);
    if (!thread) return { ok: false, error: "thread not found" };
    return { ok: true, thread };
  });

  app.post("/api/threads/:id/messages", async (request, reply) => {
    const { id } = Id.parse(request.params);
    if (!await requireThread(id, reply)) return { ok: false, error: "thread not found" };
    return { ok: true, message: await appendMessage(id, MessageInput.parse(request.body)) };
  });

  app.get("/api/threads/:id/messages", async (request, reply) => {
    const { id } = Id.parse(request.params);
    if (!await requireThread(id, reply)) return { ok: false, error: "thread not found" };
    return { ok: true, messages: await listMessages(id) };
  });

  app.post("/api/threads/:id/sandboxes", async (request, reply) => {
    const { id } = Id.parse(request.params);
    if (!await requireThread(id, reply)) return { ok: false, error: "thread not found" };
    return { ok: true, sandbox: await createSandboxRecord(id, SandboxInput.parse(request.body)) };
  });

  app.get("/api/threads/:id/sandboxes", async (request, reply) => {
    const { id } = Id.parse(request.params);
    if (!await requireThread(id, reply)) return { ok: false, error: "thread not found" };
    return { ok: true, sandboxes: await listSandboxRecords(id), current: await getCurrentSandboxRecord(id) };
  });

  app.post("/api/threads/:id/sandboxes/current/close", async (request, reply) => {
    const { id } = Id.parse(request.params);
    if (!await requireThread(id, reply)) return { ok: false, error: "thread not found" };
    const current = await getCurrentSandboxRecord(id);
    if (!current) {
      reply.code(404);
      return { ok: false, error: "sandbox not found" };
    }
    return { ok: true, sandbox: await closeSandboxRecord(current.id) };
  });

  app.post("/api/threads/:id/artifacts", async (request, reply) => {
    const { id } = Id.parse(request.params);
    if (!await requireThread(id, reply)) return { ok: false, error: "thread not found" };
    return { ok: true, artifact: await createArtifact(id, ArtifactInput.parse(request.body)) };
  });

  app.get("/api/threads/:id/artifacts", async (request, reply) => {
    const { id } = Id.parse(request.params);
    if (!await requireThread(id, reply)) return { ok: false, error: "thread not found" };
    return { ok: true, artifacts: await listArtifacts(id) };
  });

  app.post("/api/threads/:id/heartbeats", async (request, reply) => {
    const { id } = Id.parse(request.params);
    if (!await requireThread(id, reply)) return { ok: false, error: "thread not found" };
    return { ok: true, heartbeat: await createThreadHeartbeat(id, HeartbeatInput.parse(request.body)) };
  });

  app.get("/api/threads/:id/heartbeats", async (request, reply) => {
    const { id } = Id.parse(request.params);
    if (!await requireThread(id, reply)) return { ok: false, error: "thread not found" };
    return { ok: true, heartbeats: await listHeartbeats({ threadId: id }) };
  });
}

async function requireThread(id: string, reply: { code: (statusCode: number) => unknown }) {
  const thread = await getThread(id);
  if (!thread) reply.code(404);
  return thread;
}
