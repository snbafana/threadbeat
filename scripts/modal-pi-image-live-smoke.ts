import "dotenv/config";

import assert from "node:assert/strict";
import path from "node:path";

import { Database } from "../src/db.js";
import { buildModalImageCommands } from "../src/modalImage.js";
import { createSandboxProvider } from "../src/modalProvider.js";
import { MessageBus } from "../src/messageBus.js";
import { SandboxService } from "../src/sandboxService.js";
import { skipUnlessModalCredentials } from "./script-auth-utils.js";
import { printJson } from "./script-output-utils.js";
import { createScriptTempRoot, removeScriptTempRoot, scriptSettings } from "./settings-utils.js";

skipUnlessModalCredentials("Modal Pi image live smoke");

const tempRoot = await createScriptTempRoot("threadbeat-modal-pi-image-live-smoke");
const settings = scriptSettings({
  modalMode: "live",
  modalAppName: "threadbeat-modal-pi-image-live-smoke",
  tempRoot,
  overrides: {
    modalInstallSandboxPi: true,
    modalImageCommands: buildModalImageCommands({ installSandboxPi: true }),
  },
});

const db = new Database(settings.dbUrl, path.join(settings.projectRoot, "schema", "bootstrap.sql"));
let sandboxId: string | undefined;

try {
  await db.initSchema();
  const service = new SandboxService(db, createSandboxProvider(settings), new MessageBus());
  const agent = await db.createAgent({
    name: "modal-pi-image-live-smoke-agent",
    repoUrl: "https://github.com/octocat/Hello-World.git",
    currentRef: "master",
  });

  const sandbox = await service.startForAgent(agent);
  sandboxId = sandbox.id;
  const result = await service.exec(sandbox, ["bash", "-lc", "command -v pi && pi --help >/tmp/threadbeat-pi-help.txt 2>&1 && head -20 /tmp/threadbeat-pi-help.txt"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /pi/);
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
