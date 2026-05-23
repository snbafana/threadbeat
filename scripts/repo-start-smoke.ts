import assert from "node:assert/strict";

import { eventType } from "../drizzle/schema.js";
import { createAgent } from "../src/db/agents.js";
import { createArtifact, listArtifacts } from "../src/db/artifacts.js";
import { close } from "../src/db/client.js";
import { appendEvent, listEvents } from "../src/db/events.js";
import { appendMessage, listMessages } from "../src/db/messages.js";
import { closeSandboxRecord, createSandboxRecord } from "../src/db/sandboxes.js";
import { createThread, updateThreadGoal } from "../src/db/threads.js";
import { cloneRepo, createSandbox, deleteSandbox, runCommand } from "../src/sandbox/daytona.js";
import { ensureNode22Command } from "./smoke-helpers.js";

const repoUrl = process.env.THREADBEAT_RESEARCH_AGENT_REPO_URL
  ?? "https://github.com/snbafana/threadbeat-research-agent-harness.git";
const branch = process.env.THREADBEAT_RESEARCH_AGENT_BRANCH ?? "main";
const ask = "Run a minimal Threadbeat repo-start smoke: make one explicit web search, save reviewable trace evidence, and report the run directory.";

let sandboxId: string | undefined;
let sandboxRecordId: string | undefined;

try {
  const agent = await createAgent({
    id: `repo-start-agent-${Date.now()}`,
    name: "repo start smoke agent",
    repoUrl,
    defaultBranch: branch,
  });
  const thread = await createThread({
    title: "repo start smoke",
    agentId: agent.id,
    goalJson: { text: "unset", status: "needs_message_inference" },
  });
  await appendMessage(thread.id, {
    role: "human",
    contentJson: { text: ask },
  });

  const goal = {
    text: ask,
    mode: "repo-start-smoke",
    successCriteria: [
      "sandbox is created",
      "agent repo is cloned",
      "thread context is materialized",
      "agent entrypoint is executed",
      "success or failure evidence is persisted",
    ],
    constraints: [
      "message-first thread model",
      "no task table",
    ],
    inference: {
      method: "script",
      messageCount: 1,
    },
  };
  await updateThreadGoal(thread.id, goal);

  sandboxId = await createSandbox({});
  const sandbox = await createSandboxRecord(thread.id, {
    provider: "daytona",
    externalId: sandboxId,
    idleExpiresAt: new Date(Date.now() + 5 * 60_000),
  });
  sandboxRecordId = sandbox.id;
  await appendEvent(thread.id, eventType.sandboxCreated, "repo-start-smoke", { sandboxId, sandboxRecordId });

  await cloneRepo(sandboxId, repoUrl, branch);
  await appendEvent(thread.id, eventType.repoCloned, "repo-start-smoke", { repoUrl, branch });

  await step(thread.id, "node.ready", ensureNode22Command(), 240);
  await step(thread.id, "deps.installed", "npm install --no-audit --no-fund", 300);
  await materializeThreadContext(thread.id, goal);

  await appendEvent(thread.id, eventType.agentStarted, "repo-start-smoke", { entrypoint: "threadbeat-agent.mjs" });
  const run = await step(thread.id, "agent.completed", "node threadbeat-agent.mjs .threadbeat/thread.json", 360, { allowFailure: true });
  const runDir = run.stdout.match(/runs\/[^\s]+/)?.[0];
  if (run.exitCode === 0) {
    assert.match(run.stdout, /research-agent-starter-ok/);
    assert.ok(runDir, `missing run dir in stdout:\n${run.stdout}`);
    await step(thread.id, "artifacts.verified", [
      `test -f ${shellQuote(`${runDir}/trace.jsonl`)}`,
      `test -f ${shellQuote(`${runDir}/decision-log.md`)}`,
      `test -f ${shellQuote(`${runDir}/artifact-index.json`)}`,
      `test -f ${shellQuote(`${runDir}/artifacts/source-map.json`)}`,
    ].join(" && "), 60);
    await createArtifact(thread.id, {
      kind: "trace",
      uri: `sandbox://${sandboxId}/workspace/repo/${runDir}/trace.jsonl`,
      contentType: "application/jsonl",
      summaryJson: { runDir },
    });
    await createArtifact(thread.id, {
      kind: "run-bundle",
      uri: `sandbox://${sandboxId}/workspace/repo/${runDir}`,
      summaryJson: { runDir, repoUrl, branch },
    });
    await appendMessage(thread.id, {
      role: "agent",
      contentJson: {
        text: "Repo-backed agent entrypoint completed from materialized thread context.",
        runDir,
        sandboxId,
      },
    });
    await appendEvent(thread.id, eventType.threadIdle, "repo-start-smoke", { runDir });
  } else {
    const failure = `${run.stdout}\n${run.stderr}`.slice(0, 8000);
    await createArtifact(thread.id, {
      kind: "failure",
      uri: `sandbox://${sandboxId}/workspace/repo/.threadbeat/failure.txt`,
      contentType: "text/plain",
      summaryJson: { exitCode: run.exitCode, failure },
    });
    await appendEvent(thread.id, eventType.errorRaised, "repo-start-smoke", { exitCode: run.exitCode, failure });
    await appendMessage(thread.id, {
      role: "agent",
      contentJson: {
        text: "Repo-backed agent entrypoint started from materialized thread context but failed before completion.",
        exitCode: run.exitCode,
        failure,
        sandboxId,
      },
    });
    await appendEvent(thread.id, eventType.threadFailed, "repo-start-smoke", { exitCode: run.exitCode });
  }

  const messages = await listMessages(thread.id);
  assert.deepEqual(messages.map((message) => message.role), ["human", "agent"]);
  const artifacts = await listArtifacts(thread.id);
  assert.ok(artifacts.length >= 1);
  const events = await listEvents({ threadId: thread.id, limit: 100 });
  const types = events.map((event) => event.type);
  for (const type of [
    eventType.sandboxCreated,
    eventType.repoCloned,
    eventType.agentStarted,
    eventType.commandStarted,
    eventType.commandCompleted,
    run.exitCode === 0 ? eventType.artifactCreated : eventType.errorRaised,
    run.exitCode === 0 ? eventType.threadIdle : eventType.threadFailed,
  ]) {
    assert.ok(types.includes(type), `missing event ${type}`);
  }

  console.log(JSON.stringify({
    ok: true,
    threadId: thread.id,
    sandboxId,
    exitCode: run.exitCode,
    runDir,
    artifactCount: artifacts.length,
    eventCount: events.length,
  }, null, 2));
} finally {
  if (sandboxRecordId) await closeSandboxRecord(sandboxRecordId).catch(() => null);
  if (sandboxId) await deleteSandbox(sandboxId).catch(() => null);
  await close();
}

async function materializeThreadContext(threadId: string, goal: Record<string, unknown>) {
  const messages = await listMessages(threadId);
  const payload = {
    ask,
    thread: {
      id: threadId,
      goal,
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
      })),
    },
  };
  await step(threadId, "thread.context.materialized", [
    "mkdir -p .threadbeat",
    `printf '%s' ${shellQuote(JSON.stringify(payload))} > .threadbeat/thread.json`,
  ].join(" && "), 60);
}

async function step(
  threadId: string,
  checkpoint: string,
  command: string,
  timeoutSeconds: number,
  options: { allowFailure?: boolean } = {},
) {
  assert.ok(sandboxId, "missing sandboxId");
  await appendEvent(threadId, eventType.commandStarted, "repo-start-smoke", { checkpoint, command });
  const result = await runCommand(sandboxId, command, "workspace/repo", {}, timeoutSeconds);
  if (result.stdout) await appendEvent(threadId, eventType.commandStdout, "repo-start-smoke", { checkpoint, stdout: result.stdout.slice(0, 6000) });
  if (result.stderr) await appendEvent(threadId, eventType.commandStderr, "repo-start-smoke", { checkpoint, stderr: result.stderr.slice(0, 6000) });
  await appendEvent(threadId, eventType.commandCompleted, "repo-start-smoke", { checkpoint, exitCode: result.exitCode });
  if (result.exitCode !== 0 && !options.allowFailure) {
    await appendEvent(threadId, eventType.commandFailed, "repo-start-smoke", { checkpoint, exitCode: result.exitCode });
    throw new Error(`${checkpoint} failed with exit ${result.exitCode}:\n${result.stdout}\n${result.stderr}`);
  }
  if (checkpoint.startsWith("artifacts.")) {
    await appendEvent(threadId, eventType.artifactCreated, "repo-start-smoke", { checkpoint });
  }
  return result;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
