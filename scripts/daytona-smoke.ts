import assert from "node:assert/strict";

import { cloneRepo, createSandbox, deleteSandbox, runCommand } from "../src/sandbox/daytona.js";

const marker = `daytona-smoke-${Date.now()}`;
const sandboxId = await createSandbox({ THREADBEAT_SMOKE_MARKER: marker });
const checks: Array<{ name: string; exitCode: number; stdout: string }> = [];
let sandboxDeleted = false;

try {
  await check("node runtime", "node --version", "workspace", {}, 30, /^v\d+\./);
  await check("shell runtime", "command -v sh && echo shell-ok", "workspace", {}, 30, /shell-ok/);
  await check("sandbox env", 'test "$THREADBEAT_SMOKE_MARKER" = "$EXPECTED_MARKER" && echo env-ok', "workspace", { EXPECTED_MARKER: marker }, 30, /env-ok/);
  await check("workspace fs", "mkdir -p smoke && echo file-ok > smoke/marker.txt && cat smoke/marker.txt", "workspace", {}, 30, /file-ok/);
  await check("command env", 'test "$THREADBEAT_COMMAND_MARKER" = "command-ok" && echo command-env-ok', "workspace", { THREADBEAT_COMMAND_MARKER: "command-ok" }, 30, /command-env-ok/);

  await cloneRepo(sandboxId, "https://github.com/octocat/Hello-World.git", "master");
  await check("repo clone", "pwd && (test -f README || test -f README.md) && ls -la", "workspace/repo", {}, 60, /README/);

  const failure = await runCommand(sandboxId, "echo failing-intentionally && exit 17", "workspace", {}, 30);
  assert.equal(failure.exitCode, 17);
  checks.push({ name: "nonzero exit", exitCode: failure.exitCode, stdout: failure.stdout.trim() });

} finally {
  await deleteSandbox(sandboxId);
  sandboxDeleted = true;
}

console.log(JSON.stringify({
  ok: true,
  sandboxId,
  sandboxDeleted,
  checks,
}, null, 2));

async function check(
  name: string,
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeoutSeconds: number,
  pattern: RegExp,
) {
  const response = await runCommand(sandboxId, command, cwd, env, timeoutSeconds);
  assert.equal(response.exitCode, 0, `${name} failed:\n${response.stdout}`);
  assert.match(response.stdout, pattern, `${name} output mismatch:\n${response.stdout}`);
  checks.push({ name, exitCode: response.exitCode, stdout: response.stdout.trim() });
}
