import { spawn } from "node:child_process";

const includeRealTask = process.argv.includes("--real-task");
const listOnly = process.argv.includes("--list");

const steps = [
  {
    name: "GitHub hosted-agent init through CLI",
    command: ["npm", "run", "smoke:github-init-cli"],
  },
  {
    name: "Modal server and CLI sandbox control",
    command: ["npm", "run", "smoke:modal-cli"],
  },
  {
    name: "Modal Git-backed agent bootstrap with real Pi runtime",
    command: ["npm", "run", "smoke:modal-agent-real-pi-runtime"],
  },
  ...(includeRealTask
    ? [{
      name: "Modal autonomous Pi task with result commit",
      command: ["npm", "run", "smoke:modal-agent-real-task"],
    }]
    : []),
];

if (listOnly) {
  console.log(JSON.stringify({
    steps: steps.map((step) => ({
      name: step.name,
      command: step.command.join(" "),
    })),
    realTaskIncluded: includeRealTask,
  }, null, 2));
  process.exit(0);
}

if (!includeRealTask) {
  console.log("Skipping autonomous Pi task smoke; run npm run smoke:control-plane-real-task to include it.");
}

for (const step of steps) {
  console.log(`\n==> ${step.name}`);
  await run(step.command);
}

function run(command: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command.join(" ")} failed with exit ${exitCode}`));
    });
  });
}
