import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { Settings } from "../src/config.js";
import { buildServer } from "../src/server.js";

const execFileAsync = promisify(execFile);
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-detached-session-smoke-"));
const sessionName = `detached-smoke-${Date.now().toString(36)}`;

const settings: Settings = {
  projectRoot: path.resolve("."),
  dbUrl: `file:${path.join(tempRoot, "threadbeat.db")}`,
  host: "127.0.0.1",
  port: 0,
  modalMode: "dry-run",
  modalAppName: "threadbeat-detached-session-smoke",
  modalImage: "python:3.13-slim",
  githubOwner: "threadbeat-detached-session-smoke",
};

const { app } = await buildServer(settings);
let baseUrl: string | null = null;
let sessionStarted = false;

try {
  await app.listen({ host: settings.host, port: settings.port });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://${settings.host}:${address.port}`;

  const agent = await cliJson<{ agent: { id: string } }>(baseUrl, [
    "agents",
    "create",
    "--name",
    "detached-session-smoke-agent",
    "--repo",
    "https://github.com/example/agent.git",
    "--ref",
    "main",
  ]);
  const planned = await cliJson<{ run: { id: string }; plan: { branchName: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    agent.agent.id,
    "--objective",
    "detached session smoke branch",
  ]);
  assert.match(planned.plan.branchName, /^threadbeat\/runs\//);

  const session = await cliJson<{
    session: {
      session: string;
      workers: Array<{ workerId: string; pid: number | null; stdoutPath: string; stderrPath: string }>;
    };
  }>(baseUrl, [
    "runs",
    "work",
    "--agent",
    agent.agent.id,
    "--workers",
    "1",
    "--worker-prefix",
    "detached-smoke-worker",
    "--detach",
    "--session",
    sessionName,
    "--loop",
    "--idle-exit-after",
    "30",
    "--interval-ms",
    "100",
  ]);
  assert.equal(session.session.session, sessionName);
  assert.equal(session.session.workers.length, 1);
  assert.equal(session.session.workers[0].workerId, "detached-smoke-worker-1");
  assert.equal(typeof session.session.workers[0].pid, "number");
  sessionStarted = true;

  const status = await cliJson<{
    session: {
      session: string;
      workers: Array<{ workerId: string; alive: boolean; runs: Array<{ id: string; branchName: string }> }>;
    };
  }>(baseUrl, ["runs", "session-status", sessionName]);
  assert.equal(status.session.session, sessionName);
  assert.equal(status.session.workers[0].workerId, "detached-smoke-worker-1");
  assert.equal(status.session.workers[0].alive, true);

  const actions = await cliJson<{
    actions: { sessionStatus: string[]; sessionWatch: string[]; stopSession: string[] };
  }>(baseUrl, ["runs", "session-actions", sessionName]);
  assert.equal(actions.actions.sessionStatus.join(" "), `npm run cli -- runs session-status ${sessionName} --recoverable --include-stopped`);
  assert.equal(actions.actions.sessionWatch.join(" "), `npm run cli -- runs session-watch ${sessionName} --recoverable --include-stopped --next`);
  assert.equal(actions.actions.stopSession.join(" "), `npm run cli -- runs stop-session ${sessionName} --recover`);

  const logs = await cliJson<{
    workers: Array<{ workerId: string; alive: boolean; stdout: { path: string }; stderr: { path: string } }>;
  }>(baseUrl, ["runs", "session-logs", sessionName, "--lines", "5"]);
  assert.equal(logs.workers[0].workerId, "detached-smoke-worker-1");
  assert.equal(logs.workers[0].alive, true);
  assert.match(logs.workers[0].stdout.path, /worker-sessions/);
  assert.match(logs.workers[0].stderr.path, /worker-sessions/);

  const stopped = await cliJson<{
    session: string;
    stopped: Array<{ workerId: string; pid: number | null; stopped: boolean; alive: boolean }>;
  }>(baseUrl, ["runs", "stop-session", sessionName]);
  assert.equal(stopped.session, sessionName);
  assert.equal(stopped.stopped[0].workerId, "detached-smoke-worker-1");
  assert.equal(stopped.stopped[0].stopped, true);
  assert.equal(stopped.stopped[0].alive, false);

  const stoppedSessions = await cliJson<{
    sessions: Array<{ session: string; workers: Array<{ alive: boolean }> }>;
  }>(baseUrl, ["runs", "sessions", "--session", sessionName]);
  assert.equal(stoppedSessions.sessions[0].workers[0].alive, false);
} finally {
  if (sessionStarted && baseUrl !== null) {
    try {
      await cliJson(baseUrl, ["runs", "stop-session", sessionName]);
    } catch {
      // Best-effort cleanup for failed assertions before the explicit stop.
    }
  }
  await cleanupSession(sessionName);
  await app.close();
  await fs.rm(tempRoot, { recursive: true, force: true });
}

async function cliJson<T>(baseUrl: string, args: string[]): Promise<T> {
  const { stdout } = await execFileAsync("npm", ["run", "--silent", "cli", "--", ...args], {
    cwd: path.resolve("."),
    env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
  });
  return JSON.parse(stdout) as T;
}

async function cleanupSession(session: string): Promise<void> {
  await fs.rm(path.join(".threadbeat", "worker-sessions", `${session}.json`), { force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", session), { recursive: true, force: true });
}
