import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { close } from "../src/db/client.js";
import { createApp } from "../src/api/app.js";
import { assertTaskEventStream, stdoutFromEvents, type TaskEvent } from "./smoke-helpers.js";

process.env.GITHUB_TOKEN ??= execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();

assert.ok(process.env.GITHUB_TOKEN, "GITHUB_TOKEN or gh auth token is required");

const token = process.env.GITHUB_TOKEN;
const headers = {
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "content-type": "application/json",
  "user-agent": "threadbeat-agent-finance-run-smoke",
};

const app = createApp();
const user = await github("/user");
const owner = String(user.login);
const repo = `threadbeat-smoke-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let deleted = false;

try {
  await github("/user/repos", {
    method: "POST",
    body: JSON.stringify({ name: repo, private: false, auto_init: false }),
  });

  const repoUrl = `https://github.com/${owner}/${repo}.git`;
  seedAgentRepo(owner, repo, token);

  const agentId = `finance-agent-${Date.now()}`;
  const createAgent = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: {
      id: agentId,
      name: "finance run smoke",
      repoUrl,
      defaultBranch: "main",
    },
  });
  assert.equal(createAgent.statusCode, 200, createAgent.body);

  const createTask = await app.inject({
    method: "POST",
    url: `/api/agents/${agentId}/tasks`,
    payload: {
      ask: "Create finance graphs for AAPL, MSFT, NVDA, and SPY. Save CSV and PNG artifacts.",
      inputs: {
        files: [
          {
            path: ".threadbeat/symbols.txt",
            content: "AAPL\nMSFT\nNVDA\nSPY\n",
          },
        ],
      },
    },
  });
  assert.equal(createTask.statusCode, 200, createTask.body);
  const task = createTask.json<{ task: { id: string; agentId: string; runBranch: string; status: string } }>().task;
  assert.equal(task.agentId, agentId);
  assert.equal(task.runBranch, `runs/${task.id}`);

  const drain = await app.inject({ method: "POST", url: "/api/worker/drain-once", payload: {} });
  assert.equal(drain.statusCode, 200, drain.body);
  assert.equal(drain.json<{ result: { processed: number } }>().result.processed, 1);

  const taskResponse = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
  assert.equal(taskResponse.statusCode, 200, taskResponse.body);
  const completed = taskResponse.json<{ task: { status: string; error?: string } }>().task;
  assert.equal(completed.status, "succeeded", completed.error ?? JSON.stringify(completed));

  const eventsResponse = await app.inject({ method: "GET", url: `/api/events?taskId=${task.id}&limit=200` });
  assert.equal(eventsResponse.statusCode, 200, eventsResponse.body);
  const events = eventsResponse.json<{ events: TaskEvent[] }>().events;
  const types = assertTaskEventStream(events, [
    "task.created",
    "task.started",
    "sandbox.created",
    "repo.cloned",
    "command.started",
    "command.stdout",
    "command.completed",
    "checkpoint.created",
    "task.completed",
    "sandbox.deleted",
  ]);

  const stdout = stdoutFromEvents(events);
  assert.match(stdout, /finance-agent-ok/);
  assert.doesNotMatch(stdout, /gh[pousr]_[A-Za-z0-9_]+/);

  await assertBranchFile(owner, repo, task.runBranch, "artifacts/prices.csv", /AAPL,MSFT,NVDA,SPY/);
  await assertBranchFile(owner, repo, task.runBranch, "artifacts/summary.txt", /finance-agent-ok/);

  await github(`/repos/${owner}/${repo}`, { method: "DELETE" });
  deleted = true;

  console.log(JSON.stringify({
    ok: true,
    agentId,
    taskId: task.id,
    runBranch: task.runBranch,
    eventCount: events.length,
    eventTypes: types,
    sawAgentFinanceRun: true,
  }, null, 2));
} finally {
  await app.close();
  await close();
  if (!deleted) {
    try {
      await github(`/repos/${owner}/${repo}`, { method: "DELETE" });
    } catch {
      // Best-effort cleanup; the caller checks for leaked smoke repos separately.
    }
  }
}

async function github(path: string, options: RequestInit = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers ?? {}) },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path} failed: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

function seedAgentRepo(owner: string, repo: string, githubToken: string) {
  const script = agentScript();
  execFileSync("bash", ["-lc", `
    set -euo pipefail
    work="$(mktemp -d)"
    cd "$work"
    git init >/dev/null
    git config user.email threadbeat-smoke@example.com
    git config user.name threadbeat-smoke
    cat > threadbeat-agent.sh <<'SH'
${script}
SH
    chmod +x threadbeat-agent.sh
    git add threadbeat-agent.sh
    git commit -m 'seed finance agent' >/dev/null
    git branch -M main
    git remote add origin "https://x-access-token:$GITHUB_TOKEN@github.com/${owner}/${repo}.git"
    git push origin main >/dev/null
    rm -rf "$work"
  `], { env: { ...process.env, GITHUB_TOKEN: githubToken }, stdio: "pipe" });
}

function agentScript() {
  return `#!/bin/sh
set -eu
task_json="\${1:-.threadbeat/task.json}"
test -f "$task_json"
mkdir -p artifacts
python3 - <<'PY'
from pathlib import Path
import json

task = json.loads(Path(".threadbeat/task.json").read_text())
ask = task.get("ask", "")
symbols = ["AAPL", "MSFT", "NVDA", "SPY"]
Path("artifacts/prices.csv").write_text(
    "symbols," + ",".join(symbols) + "\\n" +
    "index,100,103,107,101\\n"
)
Path("artifacts/summary.txt").write_text(
    "finance-agent-ok\\nask=" + ask + "\\nsymbols=" + ",".join(symbols) + "\\n"
)
Path("artifacts/price-index.png").write_bytes(b"PNG smoke artifact " + bytes(",".join(symbols), "utf-8"))
Path("artifacts/daily-returns.png").write_bytes(b"PNG smoke artifact returns")
print("finance-agent-ok")
print("artifacts", ",".join(sorted(p.name for p in Path("artifacts").iterdir())))
PY`;
}

async function assertBranchFile(owner: string, repo: string, branch: string, path: string, pattern: RegExp) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const content = await github(`/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`);
  const encoded = String(content.content ?? "").replace(/\s/g, "");
  const text = Buffer.from(encoded, "base64").toString("utf8");
  assert.match(text, pattern, `${path} did not match ${pattern}`);
}
