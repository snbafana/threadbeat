import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { buildAgentTemplate } from "../src/agentTemplate.js";
import { createInitialCommit } from "../src/gitRepositoryBootstrap.js";
import { createScriptTempRoot, removeScriptTempRoot } from "./settings-utils.js";

const execFileAsync = promisify(execFile);
const tempRoot = await createScriptTempRoot("threadbeat-git-bootstrap-test");

try {
  await assert.rejects(
    () =>
      createInitialCommit({
        branch: "main",
        files: [{ path: "../bad", content: "bad" }],
        remoteUrl: path.join(tempRoot, "unused.git"),
      }),
    /unsafe template path/,
  );

  const remote = path.join(tempRoot, "remote.git");
  await execFileAsync("git", ["init", "--bare", remote]);

  const template = buildAgentTemplate({
    id: "bootstrap-agent",
    name: "Bootstrap Agent",
  });

  const result = await createInitialCommit({
    branch: "main",
    files: template.files,
    remoteUrl: remote,
  });

  assert.match(result.commitSha, /^[a-f0-9]{40}$/);
  assert.ok(result.filesWritten.includes("AGENTS.md"));
  assert.ok(result.filesWritten.includes(".pi/prompts/heartbeat.md"));

  const clone = path.join(tempRoot, "clone");
  await execFileAsync("git", ["clone", remote, clone]);
  const agentsMd = await fs.readFile(path.join(clone, "AGENTS.md"), "utf8");
  assert.match(agentsMd, /Bootstrap Agent/);
  assert.match(agentsMd, /Self-Improvement Rules/);
  const branch = (await execFileAsync("git", ["-C", clone, "branch", "--show-current"])).stdout.trim();
  assert.equal(branch, "main");
} finally {
  await removeScriptTempRoot(tempRoot);
}
