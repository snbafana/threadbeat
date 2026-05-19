import "../src/config.js";
import * as sandbox from "../src/daytonaProvider.js";

const sandboxId = await sandbox.createSandbox({ THREADBEAT_SMOKE_MARKER: "daytona-smoke" });

try {
  const node = await sandbox.runCommand(sandboxId, "node --version", "workspace", {}, 30);
  const env = await sandbox.runCommand(
    sandboxId,
    'test "$THREADBEAT_SMOKE_MARKER" = "daytona-smoke" && echo env-ok',
    "workspace",
    { THREADBEAT_SMOKE_MARKER: "daytona-smoke" },
    30,
  );
  await sandbox.cloneRepo(sandboxId, "https://github.com/octocat/Hello-World.git");
  const repo = await sandbox.runCommand(sandboxId, "ls -la", "workspace/repo", {}, 30);
  const ok = node.exitCode === 0 && env.exitCode === 0 && repo.exitCode === 0;
  console.log(JSON.stringify({
    ok,
    sandboxId,
    node: node.stdout.trim(),
    env: env.stdout.trim(),
    repoLines: repo.stdout.split("\n").length,
  }, null, 2));
  if (!ok) process.exitCode = 1;
} finally {
  await sandbox.deleteSandbox(sandboxId);
}
