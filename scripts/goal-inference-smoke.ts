import assert from "node:assert/strict";

import { createAgent } from "../src/db/agents.js";
import { close } from "../src/db/client.js";
import { appendMessage, listMessages, type Message } from "../src/db/messages.js";
import { createThread, getThread, updateThreadGoal } from "../src/db/threads.js";

const model = process.env.THREADBEAT_GOAL_MODEL ?? "deepseek-chat";

try {
  const agent = await createAgent({
    id: `goal-agent-${Date.now()}`,
    name: "goal inference smoke agent",
    repoUrl: "https://github.com/snbafana/threadbeat-research-agent-harness.git",
    defaultBranch: "main",
  });
  const thread = await createThread({
    title: "goal inference smoke",
    agentId: agent.id,
    goalJson: { text: "unset", status: "needs_inference" },
  });

  await appendMessage(thread.id, {
    role: "human",
    contentJson: {
      text: "I want this repo-backed research agent to become good at web research.",
      priority: "tool reliability",
    },
  });
  await appendMessage(thread.id, {
    role: "human",
    contentJson: {
      text: "Start with search tool calls, save traces, and make the harness easy to improve from run evidence.",
      success: ["search works", "trace evidence is inspectable", "repo can be updated from failures"],
    },
  });
  await appendMessage(thread.id, {
    role: "heartbeat",
    contentJson: {
      text: "Continue the same goal from the latest messages, do not create a separate task.",
    },
  });

  const messages = await listMessages(thread.id);
  const inferred = await inferGoal(messages);
  assert.equal(typeof inferred.text, "string");
  assert.match(inferred.text, /research|search|web/i);
  assert.ok(Array.isArray(inferred.successCriteria));
  assert.ok(inferred.successCriteria.length >= 2);

  const updated = await updateThreadGoal(thread.id, inferred);
  assert.ok(updated);
  const reloaded = await getThread(thread.id);
  assert.deepEqual(reloaded?.goal, inferred);

  console.log(JSON.stringify({
    ok: true,
    threadId: thread.id,
    method: inferred.inference.method,
    model: inferred.inference.model,
    goal: inferred,
  }, null, 2));
} finally {
  await close();
}

type InferredGoal = {
  text: string;
  mode: string;
  successCriteria: string[];
  constraints: string[];
  inference: {
    method: "llm" | "heuristic";
    model?: string;
    messageCount: number;
  };
};

async function inferGoal(messages: Message[]): Promise<InferredGoal> {
  if (process.env.DEEPSEEK_API_KEY) {
    return inferGoalWithDeepseek(messages);
  }
  return inferGoalHeuristically(messages);
}

async function inferGoalWithDeepseek(messages: Message[]): Promise<InferredGoal> {
  const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "Infer the current goal of a durable agent thread from ordered JSON messages.",
            "Return only JSON with keys: text, mode, successCriteria, constraints.",
            "successCriteria and constraints must be arrays of short strings.",
          ].join(" "),
        },
        {
          role: "user",
          content: JSON.stringify(messages.map((message) => ({
            role: message.role,
            content: message.content,
            createdAt: message.createdAt,
          }))),
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(await response.text());
  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = body.choices?.[0]?.message?.content;
  assert.ok(content, "missing goal inference response");
  const parsed = JSON.parse(content) as Partial<InferredGoal>;
  return normalizeGoal(parsed, { method: "llm", model, messageCount: messages.length });
}

function inferGoalHeuristically(messages: Message[]): InferredGoal {
  const text = messages
    .map((message) => JSON.stringify(message.content))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return normalizeGoal({
    text: text.slice(0, 280),
    mode: "research-agent-improvement",
    successCriteria: [
      "search tool calls work",
      "trace evidence is inspectable",
      "repo updates can be made from failures",
    ],
    constraints: [
      "message-first thread model",
      "no task abstraction",
    ],
  }, { method: "heuristic", messageCount: messages.length });
}

function normalizeGoal(goal: Partial<InferredGoal>, inference: InferredGoal["inference"]): InferredGoal {
  return {
    text: requireString(goal.text, "goal.text"),
    mode: goal.mode && typeof goal.mode === "string" ? goal.mode : "research",
    successCriteria: requireStringArray(goal.successCriteria, "goal.successCriteria"),
    constraints: Array.isArray(goal.constraints) ? goal.constraints.filter((item): item is string => typeof item === "string") : [],
    inference,
  };
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  assert.notEqual(value.trim(), "", `${label} must not be empty`);
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  const strings = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  assert.ok(strings.length > 0, `${label} must contain strings`);
  return strings;
}
