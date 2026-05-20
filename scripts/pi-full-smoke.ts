import { spawn } from "node:child_process";

const scripts = [
  "scripts/smoke-cleanup.ts",
  "scripts/agent-registry-smoke.ts",
  "scripts/event-types-smoke.ts",
  "scripts/pi-daytona-smoke.ts",
  "scripts/pi-task-events-smoke.ts",
  "scripts/pi-agent-session-task-smoke.ts",
  "scripts/github-remote-task-smoke.ts",
  "scripts/agent-finance-run-smoke.ts",
  "scripts/finance-graphs-task-smoke.ts",
];

for (const script of scripts) {
  await runWithRetry(script);
}

console.log(JSON.stringify({ ok: true, scripts }, null, 2));

async function runWithRetry(script: string) {
  const attempts = Number(process.env.THREADBEAT_PI_FULL_SMOKE_ATTEMPTS ?? 2);
  let lastCode = 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    lastCode = await run(script, attempt, attempts);
    if (lastCode === 0) return;
  }
  throw new Error(`${script} failed after ${attempts} attempts with exit code ${lastCode}`);
}

async function run(script: string, attempt: number, attempts: number) {
  console.log(`\n== ${script} ==`);
  if (attempts > 1) console.log(`attempt ${attempt}/${attempts}`);
  return await new Promise<number>((resolve) => {
    const child = spawn("npx", ["tsx", script], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    child.on("close", (exitCode) => resolve(exitCode ?? 1));
  });
}
