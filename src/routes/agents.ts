import type { FastifyInstance } from "fastify";

import { eventType } from "../../drizzle/schema.js";
import { AgentTask, Id } from "../input.js";
import { appendEvent } from "../store/events.js";
import { AgentUpdate, deleteAgent, getAgent, listAgents, NewAgent, updateAgent, upsertAgent } from "../store/agents.js";
import { createTask } from "../store/tasks.js";

export function registerAgentRoutes(app: FastifyInstance) {
  app.post("/api/agents", async (request) => {
    const agent = await upsertAgent(NewAgent.parse(request.body));
    return { ok: true, agent };
  });

  app.get("/api/agents", async () => ({ ok: true, agents: await listAgents() }));

  app.get("/api/agents/:id", async (request, reply) => {
    const { id } = Id.parse(request.params);
    const agent = await getAgent(id);
    if (!agent) {
      reply.code(404);
      return { ok: false, error: "agent not found" };
    }
    return { ok: true, agent };
  });

  app.put("/api/agents/:id", async (request, reply) => {
    const { id } = Id.parse(request.params);
    const agent = await updateAgent(id, AgentUpdate.parse(request.body));
    if (!agent) {
      reply.code(404);
      return { ok: false, error: "agent not found" };
    }
    return { ok: true, agent };
  });

  app.delete("/api/agents/:id", async (request, reply) => {
    const { id } = Id.parse(request.params);
    const agent = await deleteAgent(id);
    if (!agent) {
      reply.code(404);
      return { ok: false, error: "agent not found" };
    }
    return { ok: true };
  });

  app.post("/api/agents/:id/tasks", async (request, reply) => {
    const { id } = Id.parse(request.params);
    const agent = await getAgent(id);
    if (!agent) {
      reply.code(404);
      return { ok: false, error: "agent not found" };
    }
    const taskSpec = AgentTask.parse(request.body);
    const task = await createTask(taskSpec, { agentId: agent.id });
    await appendEvent(task.id, eventType.taskCreated, "api", {
      agentId: agent.id,
      spec: taskSpec,
      runBranch: task.runBranch,
    });
    return { ok: true, task };
  });
}
