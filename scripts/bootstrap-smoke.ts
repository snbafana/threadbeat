import assert from "node:assert/strict";

import { buildSandboxBootstrapCommands } from "../src/sandboxBootstrap.js";
import {
  createScriptTempRoot,
  removeScriptTempRoot,
  scriptDatabase,
  scriptSandboxService,
  scriptSettings,
} from "./settings-utils.js";

const tempRoot = await createScriptTempRoot("threadbeat-bootstrap-smoke");

const settings = scriptSettings({
  modalAppName: "threadbeat-bootstrap-smoke",
  tempRoot,
});

const db = scriptDatabase(settings);

try {
  await db.initSchema();
  const service = scriptSandboxService(db, settings);
  const agent = await db.createAgent({
    name: "bootstrap-smoke-agent",
    repoUrl: "https://github.com/example/agent.git",
    currentRef: "main",
  });

  const sandbox = await service.startForAgent(agent);
  const results = await service.bootstrap(sandbox);

  assert.deepEqual(
    results.map((result) => result.command.join(" ")),
    [
      "mkdir -p /workspace",
      "sh -lc command -v git >/dev/null || (apt-get update && apt-get install -y git)",
      "git clone -- https://github.com/example/agent.git /workspace/agent",
      "git -C /workspace/agent checkout main",
      "git -C /workspace/agent status --short --branch",
    ],
  );
  assert.ok(results.every((result) => result.exitCode === 0));

  const messages = await db.listMessages({ sandboxId: sandbox.id, limit: 100 });
  assert.ok(messages.some((message) => message.type === "bootstrap_started"));
  assert.ok(messages.some((message) => message.type === "bootstrap_completed"));
  assert.ok(messages.some((message) => message.type === "exec_started" && message.text?.includes("git clone")));
  assert.ok(messages.some((message) => message.type === "exec_completed"));

  const secretSandbox = await service.startForAgent(agent);
  await service.bootstrap(secretSandbox, {
    repoUrl: "https://t:SECRET@example.test/private-agent.git",
    repoUrlRedacted: "https://t:REDACTED@example.test/private-agent.git",
  });
  const secretMessages = await db.listMessages({ sandboxId: secretSandbox.id, limit: 100 });
  assert.ok(secretMessages.some((message) => message.type === "exec_started" && message.text?.includes("REDACTED")));
  assert.ok(secretMessages.some((message) => message.type === "exec_completed"));
  assert.ok(secretMessages.every((message) => !message.text?.includes("SECRET")));

  assert.deepEqual(
    buildSandboxBootstrapCommands({
      baseRef: "main",
      pushRef: true,
      ref: "threadbeat/runs/test",
      repoUrl: "https://github.com/example/agent.git",
      workdir: "/workspace/agent",
    }).map((command) => command.join(" ")),
    [
      "mkdir -p /workspace",
      "sh -lc command -v git >/dev/null || (apt-get update && apt-get install -y git)",
      "git clone -- https://github.com/example/agent.git /workspace/agent",
      "sh -lc git -C '/workspace/agent' checkout 'threadbeat/runs/test' || git -C '/workspace/agent' checkout -B 'threadbeat/runs/test' 'main'",
      "git -C /workspace/agent status --short --branch",
      "git -C /workspace/agent push -u origin HEAD:threadbeat/runs/test",
    ],
  );
} finally {
  await db.close();
  await removeScriptTempRoot(tempRoot);
}
