import fs from "node:fs/promises";

const baseUrl = process.env.THREADBEAT_API_URL ?? "http://127.0.0.1:8000";
const matrixPath = process.argv[2] ?? "test/fixtures/repo-matrix.json";
const matrix = JSON.parse(await fs.readFile(matrixPath, "utf8")) as Array<{ name: string; expect: "succeeded" | "failed"; spec: unknown }>;

const results = [];
for (const entry of matrix) {
  console.log(`matrix: ${entry.name}`);
  const created = await request<{ task: { id: string } }>("POST", "/api/tasks", entry.spec);
  await request("POST", "/api/worker/drain-once", {});
  const task = await request<{ task: { status: string; error: string | null } }>("GET", `/api/tasks/${created.task.id}`);
  const passed = task.task.status === entry.expect;
  results.push({ name: entry.name, taskId: created.task.id, expected: entry.expect, actual: task.task.status, passed, error: task.task.error });
  console.log(`  ${passed ? "ok" : "fail"} expected=${entry.expect} actual=${task.task.status}`);
}

console.log(JSON.stringify({ ok: results.every((result) => result.passed), results }, null, 2));
if (!results.every((result) => result.passed)) process.exitCode = 1;

async function request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(json.error ?? `${method} ${path} failed with ${response.status}`);
  return json;
}
