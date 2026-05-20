import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { close } from "../src/store/db.js";
import { createApp } from "../src/app.js";
import { assertTaskEventStream, piFixture, stdoutFromEvents, type TaskEvent } from "./smoke-helpers.js";

process.env.GITHUB_TOKEN ??= execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();

assert.ok(process.env.GITHUB_TOKEN, "GITHUB_TOKEN or gh auth token is required");

const app = createApp();

try {
  const create = await app.inject({
    method: "POST",
    url: "/api/tasks",
    payload: {
      repo: { url: piFixture.repoUrl, branch: piFixture.branch },
      setup: [
        {
          cmd: "git rev-parse --is-inside-work-tree && test -f package.json && test -d src",
          timeoutSeconds: 60,
        },
      ],
      main: {
        cmd: githubRemoteCommand(),
        timeoutSeconds: 180,
      },
      verify: [
        {
          cmd: "test -f .threadbeat-github-remote-smoke.json && grep -q github-remote-ok .threadbeat-github-remote-smoke.json",
          timeoutSeconds: 30,
        },
      ],
    },
  });
  assert.equal(create.statusCode, 200, create.body);
  const taskId = create.json<{ task: { id: string } }>().task.id;

  const drain = await app.inject({ method: "POST", url: "/api/worker/drain-once", payload: {} });
  assert.equal(drain.statusCode, 200, drain.body);
  assert.equal(drain.json<{ result: { processed: number } }>().result.processed, 1);

  const taskResponse = await app.inject({ method: "GET", url: `/api/tasks/${taskId}` });
  assert.equal(taskResponse.statusCode, 200, taskResponse.body);
  const task = taskResponse.json<{ task: { status: string; error?: string } }>().task;
  assert.equal(task.status, "succeeded", task.error ?? JSON.stringify(task));

  const eventsResponse = await app.inject({ method: "GET", url: `/api/events?taskId=${taskId}&limit=100` });
  assert.equal(eventsResponse.statusCode, 200, eventsResponse.body);
  const events = eventsResponse.json<{ events: TaskEvent[] }>().events;
  assertTaskEventStream(events, [
    "task.created",
    "task.started",
    "sandbox.created",
    "repo.cloned",
    "command.started",
    "command.stdout",
    "command.completed",
    "task.completed",
    "sandbox.deleted",
  ]);

  const stdout = stdoutFromEvents(events);
  assert.match(stdout, /github-remote-created/);
  assert.match(stdout, /github-remote-cloned/);
  assert.match(stdout, /github-remote-deleted/);
  assert.match(stdout, /github-remote-ok/);
  assert.doesNotMatch(stdout, /gh[pousr]_[A-Za-z0-9_]+/);

  console.log(JSON.stringify({
    ok: true,
    taskId,
    taskStatus: task.status,
    eventCount: events.length,
    sawGithubRemote: true,
  }, null, 2));
} finally {
  await app.close();
  await close();
}

function githubRemoteCommand() {
  return String.raw`cat > .threadbeat-github-remote-smoke.mjs <<'EOF'
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import process from "node:process";

const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error("missing GITHUB_TOKEN");

const headers = {
  authorization: "Bearer " + token,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "content-type": "application/json",
  "user-agent": "threadbeat-github-remote-smoke",
};

async function request(path, options = {}) {
  const response = await fetch("https://api.github.com" + path, {
    ...options,
    headers: { ...headers, ...(options.headers ?? {}) },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error((options.method ?? "GET") + " " + path + " failed: " + response.status + " " + JSON.stringify(data));
  }
  return data;
}

const user = await request("/user");
const owner = user.login;
const repo = "threadbeat-smoke-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
let deleted = false;

try {
  await request("/user/repos", {
    method: "POST",
    body: JSON.stringify({ name: repo, private: true, auto_init: false }),
  });
  console.log("github-remote-created");

  rmSync(".threadbeat-github-work", { recursive: true, force: true });
  rmSync(".threadbeat-github-verify", { recursive: true, force: true });
  mkdirSync(".threadbeat-github-work");
  process.chdir(".threadbeat-github-work");

  execFileSync("git", ["init"], { stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "threadbeat-smoke@example.com"], { stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "threadbeat-smoke"], { stdio: "pipe" });
  writeFileSync("README.md", "# Threadbeat remote smoke\n\ngithub-remote-ok\n");
  execFileSync("git", ["add", "README.md"], { stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "threadbeat remote smoke"], { stdio: "pipe" });
  execFileSync("git", ["branch", "-M", "main"], { stdio: "pipe" });
  const authedUrl = "https://x-access-token:" + token + "@github.com/" + owner + "/" + repo + ".git";
  execFileSync("git", ["remote", "add", "origin", authedUrl], { stdio: "pipe" });
  execFileSync("git", ["push", "origin", "main"], { stdio: "pipe" });

  process.chdir("..");
  execFileSync("git", ["clone", authedUrl, ".threadbeat-github-verify"], { stdio: "pipe" });
  console.log("github-remote-cloned");

  process.chdir(".threadbeat-github-verify");
  execFileSync("grep", ["-q", "github-remote-ok", "README.md"], { stdio: "pipe" });
  process.chdir("..");

  await request("/repos/" + owner + "/" + repo, { method: "DELETE" });
  deleted = true;
  console.log("github-remote-deleted");

  writeFileSync(".threadbeat-github-remote-smoke.json", JSON.stringify({ status: "github-remote-ok", owner, repo }, null, 2));
  console.log("github-remote-ok");
} finally {
  if (!deleted) {
    try {
      await request("/repos/" + owner + "/" + repo, { method: "DELETE" });
      console.log("github-remote-deleted");
    } catch {
      console.log("github-remote-delete-failed");
    }
  }
}
EOF
node .threadbeat-github-remote-smoke.mjs 2>&1`;
}
