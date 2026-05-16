import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const workerSessionRoot = path.join(process.cwd(), ".threadbeat", "worker-sessions");
const baseEnv = { ...process.env, THREADBEAT_BASE_URL: "http://127.0.0.1:1" };
const suffix = Date.now().toString(36);

const cases = [
  {
    session: `worker-record-drain-${suffix}`,
    workerId: `drain-worker-${suffix}`,
    workerDir: "drain-continuation-workers",
    start: ["runs", "session-drain-continuations", `worker-record-drain-${suffix}`, "--execute-queued", "--detach", "--worker-id", `drain-worker-${suffix}`, "--max-continuations", "1"],
    list: ["runs", "session-drain-workers", `worker-record-drain-${suffix}`, "--worker-id", `drain-worker-${suffix}`, "--lines", "1"],
    stop: ["runs", "stop-drain-workers", `worker-record-drain-${suffix}`, "--worker-id", `drain-worker-${suffix}`, "--lines", "1"],
    restart: ["runs", "restart-drain-workers", `worker-record-drain-${suffix}`, "--worker-id", `drain-worker-${suffix}`, "--lines", "1"],
  },
  {
    session: `worker-record-apply-${suffix}`,
    workerId: `apply-worker-${suffix}`,
    workerDir: "apply-action-workers",
    start: ["runs", "session-applies", `worker-record-apply-${suffix}`, "--server", "--action-queue", "--execute-queued", "--detach", "--worker-id", `apply-worker-${suffix}`, "--max-actions", "1"],
    list: ["runs", "session-apply-action-workers", `worker-record-apply-${suffix}`, "--worker-id", `apply-worker-${suffix}`, "--lines", "1"],
    stop: ["runs", "stop-apply-action-workers", `worker-record-apply-${suffix}`, "--worker-id", `apply-worker-${suffix}`, "--lines", "1"],
    restart: ["runs", "restart-apply-action-workers", `worker-record-apply-${suffix}`, "--worker-id", `apply-worker-${suffix}`, "--lines", "1"],
  },
  {
    session: `worker-record-watch-${suffix}`,
    workerId: `watch-worker-${suffix}`,
    workerDir: "watch-workers",
    start: ["runs", "start-session-watch-worker", `worker-record-watch-${suffix}`, "--worker-id", `watch-worker-${suffix}`, "--watch-id", `watch-${suffix}`, "--max-polls", "1", "--interval-ms", "1"],
    list: ["runs", "session-watch-workers", `worker-record-watch-${suffix}`, "--worker-id", `watch-worker-${suffix}`, "--lines", "1"],
    stop: ["runs", "stop-session-watch-workers", `worker-record-watch-${suffix}`, "--worker-id", `watch-worker-${suffix}`, "--lines", "1"],
    restart: ["runs", "restart-session-watch-workers", `worker-record-watch-${suffix}`, "--worker-id", `watch-worker-${suffix}`, "--lines", "1"],
  },
  {
    session: `worker-record-replay-${suffix}`,
    workerId: `replay-loop-worker-${suffix}`,
    workerDir: "terminal-overview-replay-loop-workers",
    start: ["runs", "start-terminal-overview-replay-loop-worker", `worker-record-replay-${suffix}`, "--worker-id", `replay-loop-worker-${suffix}`, "--dry-run", "--max-steps", "1"],
    list: ["runs", "terminal-overview-replay-loop-workers", `worker-record-replay-${suffix}`, "--worker-id", `replay-loop-worker-${suffix}`, "--lines", "1"],
    stop: ["runs", "stop-terminal-overview-replay-loop-workers", `worker-record-replay-${suffix}`, "--worker-id", `replay-loop-worker-${suffix}`, "--lines", "1"],
    restart: ["runs", "restart-terminal-overview-replay-loop-worker", `worker-record-replay-${suffix}`, "--worker-id", `replay-loop-worker-${suffix}`, "--lines", "1"],
  },
];

try {
  for (const testCase of cases) {
    await rmSessionDir(testCase.workerDir, testCase.session);
    await cli(testCase.start);
    await assertStoredRecord(testCase, "start");
    await cli(testCase.list);
    await assertStoredRecord(testCase, "list");
    await cli(testCase.stop);
    const stopped = await assertStoredRecord(testCase, "stop");
    assert.equal(typeof stopped.stoppedAt, "string", `${testCase.workerId} should record stoppedAt`);
    await cli(testCase.restart);
    const restarted = await assertStoredRecord(testCase, "restart");
    assert.equal(restarted.restartCount, 1, `${testCase.workerId} should record restartCount`);
    await cli(testCase.stop);
    await assertStoredRecord(testCase, "cleanup stop");
  }
} finally {
  await Promise.all(cases.map((testCase) => rmSessionDir(testCase.workerDir, testCase.session)));
}

console.log(`worker record sanitization smoke passed for ${cases.length} worker types`);

async function cli(args: string[]): Promise<void> {
  await execFileAsync("npm", ["run", "--silent", "cli", "--", ...args], {
    env: baseEnv,
    maxBuffer: 1024 * 1024,
  });
}

async function assertStoredRecord(
  testCase: { workerDir: string; session: string; workerId: string },
  step: string,
): Promise<Record<string, unknown>> {
  const record = JSON.parse(await fs.readFile(recordPath(testCase), "utf8")) as Record<string, unknown>;
  for (const key of ["alive", "stdout", "stderr"]) {
    assert.equal(Object.hasOwn(record, key), false, `${testCase.workerId} persisted ${key} after ${step}`);
  }
  assert.equal(record.session, testCase.session);
  assert.equal(record.workerId, testCase.workerId);
  assert.equal(typeof record.stdoutPath, "string");
  assert.equal(typeof record.stderrPath, "string");
  return record;
}

function recordPath(testCase: { workerDir: string; session: string; workerId: string }): string {
  return path.join(workerSessionRoot, testCase.workerDir, testCase.session, `${testCase.workerId}.json`);
}

async function rmSessionDir(workerDir: string, session: string): Promise<void> {
  await fs.rm(path.join(workerSessionRoot, workerDir, session), { recursive: true, force: true });
}
