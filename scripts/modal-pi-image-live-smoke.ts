import "dotenv/config";

import assert from "node:assert/strict";

import { buildModalImageCommands } from "../src/modalImage.js";
import { skipUnlessModalCredentials } from "./script-auth-utils.js";
import { printJson } from "./script-output-utils.js";
import {
  createScriptTempRoot,
  removeScriptTempRoot,
  scriptDatabase,
  scriptSandboxService,
  scriptSettings,
  stopScriptSandboxIfRunning,
} from "./settings-utils.js";

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

const db = scriptDatabase(settings);
const service = scriptSandboxService(db, settings);
let sandboxId: string | undefined;

try {
  await db.initSchema();
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
  await stopScriptSandboxIfRunning(db, service, sandboxId);
  await db.close();
  await removeScriptTempRoot(tempRoot);
}
