import "dotenv/config";

import assert from "node:assert/strict";
import path from "node:path";

import { Database } from "../src/db.js";
import { createSandboxProvider } from "../src/modalProvider.js";
import { MessageBus } from "../src/messageBus.js";
import { SandboxService } from "../src/sandboxService.js";
import { skipUnlessModalCredentials } from "./script-auth-utils.js";
import { printJson } from "./script-output-utils.js";
import { createScriptTempRoot, removeScriptTempRoot, scriptSettings } from "./settings-utils.js";

skipUnlessModalCredentials("Modal live smoke");

const tempRoot = await createScriptTempRoot("threadbeat-modal-live-smoke");
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

  printJson({
    ok: true,
  });
} finally {
  if (sandboxId) {
    const sandbox = await db.getSandbox(sandboxId);
    if (sandbox?.state === "running") {
      await new SandboxService(db, createSandboxProvider(settings), new MessageBus()).stop(sandbox);
    }
  }
  await db.close();
  await removeScriptTempRoot(tempRoot);
}
