import { loadSettings } from "../src/config.js";
import { DaytonaSandboxProvider } from "../src/daytonaProvider.js";

const settings = loadSettings();
const provider = new DaytonaSandboxProvider(settings);
const sandbox = await provider.createSandbox({ THREADBEAT_SMOKE_MARKER: "daytona-smoke" });

try {
  const node = await provider.runCommand(sandbox, { cmd: "node --version", timeoutSeconds: 30 }, "workspace", {});
  const env = await provider.runCommand(
    sandbox,
    { cmd: "test \"$THREADBEAT_SMOKE_MARKER\" = \"daytona-smoke\" && echo env-ok", timeoutSeconds: 30 },
    "workspace",
    { THREADBEAT_SMOKE_MARKER: "daytona-smoke" },
  );
  await provider.cloneRepo(sandbox, { url: "https://github.com/octocat/Hello-World.git" });
  const repo = await provider.runCommand(sandbox, { cmd: "ls -la", timeoutSeconds: 30 }, "workspace/repo", {});
  const ok = node.exitCode === 0 && env.exitCode === 0 && repo.exitCode === 0;
  console.log(JSON.stringify({
    ok,
    sandboxId: sandbox.id,
    node: node.stdout.trim(),
    env: env.stdout.trim(),
    repoLines: repo.stdout.split("\n").length,
  }, null, 2));
  if (!ok) process.exitCode = 1;
} finally {
  await provider.deleteSandbox(sandbox);
}
