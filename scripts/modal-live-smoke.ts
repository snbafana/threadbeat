import "dotenv/config";

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { hasModalCredentials } from "../src/auth.js";
import { Database } from "../src/db.js";
import { createSandboxProvider } from "../src/modalProvider.js";
import { MessageBus } from "../src/messageBus.js";
import { SandboxService } from "../src/sandboxService.js";
import { scriptSettings } from "./settings-utils.js";

if (!hasModalCredentials(process.env)) {
  console.log("Modal live smoke skipped: MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are not set");
  process.exit(0);
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-modal-live-smoke-"));
const settings = scriptSettings({
  modalMode: "live",
  modalAppName: "threadbeat-modal-live-smoke",
  tempRoot,
  overrides: {
    sandboxEnv: {
      THREADBEAT_SANDBOX_ENV_SMOKE: "present",
    },
    sandboxEnvNames: ["THREADBEAT_SANDBOX_ENV_SMOKE"],
  },
});

const db = new Database(settings.dbUrl, path.join(settings.projectRoot, "schema", "bootstrap.sql"));
let sandboxId: string | undefined;

try {
  await db.initSchema();
  const service = new SandboxService(db, createSandboxProvider(settings), new MessageBus());
  const agent = await db.createAgent({
    name: "modal-live-smoke-agent",
    repoUrl: "https://github.com/octocat/Hello-World.git",
    currentRef: "master",
  });

  const sandbox = await service.startForAgent(agent);
  sandboxId = sandbox.id;
  const result = await service.exec(sandbox, ["python", "--version"]);
  assert.equal(result.exitCode, 0);
  assert.match(`${result.stdout}${result.stderr}`, /Python/);
  const envCheck = await service.exec(sandbox, ["bash", "-lc", "printf \"$THREADBEAT_SANDBOX_ENV_SMOKE\""]);
  assert.equal(envCheck.exitCode, 0);
  assert.equal(envCheck.stdout, "present");
  await service.stop(sandbox);
  assert.equal((await db.getSandbox(sandbox.id))?.state, "stopped");

  console.log(JSON.stringify({
    ok: true,
  }, null, 2));
} finally {
  if (sandboxId) {
    const sandbox = await db.getSandbox(sandboxId);
    if (sandbox?.state === "running") {
      await new SandboxService(db, createSandboxProvider(settings), new MessageBus()).stop(sandbox);
    }
  }
  await db.close();
  await fs.rm(tempRoot, { recursive: true, force: true });
}
