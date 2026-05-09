import "dotenv/config";

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Settings } from "../src/config.js";
import { Database } from "../src/db.js";
import { buildModalImageCommands } from "../src/modalImage.js";
import { createSandboxProvider } from "../src/modalProvider.js";
import { MessageBus } from "../src/messageBus.js";
import { SandboxService } from "../src/sandboxService.js";

if (!process.env.MODAL_TOKEN_ID || !process.env.MODAL_TOKEN_SECRET) {
  console.log("Modal Pi image live smoke skipped: MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are not set");
  process.exit(0);
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-modal-pi-image-live-smoke-"));
const settings: Settings = {
  projectRoot: process.cwd(),
  dbUrl: `file:${path.join(tempRoot, "threadbeat.db")}`,
  host: "127.0.0.1",
  port: 0,
  modalMode: "live",
  modalAppName: process.env.THREADBEAT_MODAL_APP_NAME ?? "threadbeat-modal-pi-image-live-smoke",
  modalImage: process.env.THREADBEAT_MODAL_IMAGE ?? "python:3.13-slim",
  modalInstallSandboxPi: true,
  modalImageCommands: buildModalImageCommands({ installSandboxPi: true }),
};

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
