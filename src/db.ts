import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import type { AppendEventInput, CreateTaskInput, EventRow, RunRow, TaskRow, TaskSpec, TaskStatus } from "./types.js";

const { Pool } = pg;

export interface TaskRepository {
  createTask(input: CreateTaskInput): Promise<TaskRow>;
  listTasks(): Promise<TaskRow[]>;
  getTask(id: string): Promise<TaskRow | null>;
  claimNextTask(): Promise<TaskRow | null>;
  markTaskRunning(id: string): Promise<void>;
  markTaskSucceeded(id: string): Promise<void>;
  markTaskFailed(id: string, error: string): Promise<void>;
  createRun(taskId: string): Promise<RunRow>;
  setRunSandbox(runId: string, sandboxId: string): Promise<void>;
  markRunSucceeded(runId: string): Promise<void>;
  markRunFailed(runId: string, error: string): Promise<void>;
  listRuns(): Promise<RunRow[]>;
  getRun(id: string): Promise<RunRow | null>;
  appendEvent(input: AppendEventInput): Promise<EventRow>;
  listEvents(filter: EventFilter): Promise<EventRow[]>;
  close(): Promise<void>;
}

export type EventFilter = {
  taskId?: string;
  runId?: string;
  after?: number;
  limit?: number;
};

type PgTaskRecord = {
  id: string;
  status: TaskStatus;
  spec_json: TaskSpec;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  error: string | null;
};

type PgRunRecord = {
  id: string;
  task_id: string;
  status: RunRow["status"];
  sandbox_id: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  error: string | null;
};

type PgEventRecord = {
  id: string;
  seq: string | number;
  task_id: string;
  run_id: string | null;
  type: EventRow["type"];
  source: EventRow["source"];
  message: string | null;
  data_json: Record<string, unknown> | null;
  created_at: Date;
};

export class PostgresTaskRepository implements TaskRepository {
  private readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async bootstrap(): Promise<void> {
    const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../schema/bootstrap.sql");
    await this.pool.query(await fs.readFile(schemaPath, "utf8"));
  }

  async createTask(input: CreateTaskInput): Promise<TaskRow> {
    const id = randomUUID();
    const result = await this.pool.query<PgTaskRecord>(
      "INSERT INTO tasks (id, status, spec_json) VALUES ($1, 'queued', $2) RETURNING *",
      [id, input.spec],
    );
    return taskFromRecord(result.rows[0]);
  }

  async listTasks(): Promise<TaskRow[]> {
    const result = await this.pool.query<PgTaskRecord>("SELECT * FROM tasks ORDER BY created_at DESC");
    return result.rows.map(taskFromRecord);
  }

  async getTask(id: string): Promise<TaskRow | null> {
    const result = await this.pool.query<PgTaskRecord>("SELECT * FROM tasks WHERE id = $1", [id]);
    return result.rows[0] ? taskFromRecord(result.rows[0]) : null;
  }

  async claimNextTask(): Promise<TaskRow | null> {
    const result = await this.pool.query<PgTaskRecord>(
      [
        "UPDATE tasks",
        "SET status = 'claimed'",
        "WHERE id = (",
        "  SELECT id FROM tasks",
        "  WHERE status = 'queued'",
        "  ORDER BY created_at ASC",
        "  LIMIT 1",
        ")",
        "RETURNING *",
      ].join("\n"),
    );
    return result.rows[0] ? taskFromRecord(result.rows[0]) : null;
  }

  async markTaskRunning(id: string): Promise<void> {
    await this.pool.query("UPDATE tasks SET status = 'running', started_at = COALESCE(started_at, now()) WHERE id = $1", [id]);
  }

  async markTaskSucceeded(id: string): Promise<void> {
    await this.pool.query("UPDATE tasks SET status = 'succeeded', completed_at = now(), error = NULL WHERE id = $1", [id]);
  }

  async markTaskFailed(id: string, error: string): Promise<void> {
    await this.pool.query("UPDATE tasks SET status = 'failed', completed_at = now(), error = $2 WHERE id = $1", [id, error]);
  }

  async createRun(taskId: string): Promise<RunRow> {
    const id = randomUUID();
    const result = await this.pool.query<PgRunRecord>(
      "INSERT INTO runs (id, task_id, status, started_at) VALUES ($1, $2, 'running', now()) RETURNING *",
      [id, taskId],
    );
    return runFromRecord(result.rows[0]);
  }

  async setRunSandbox(runId: string, sandboxId: string): Promise<void> {
    await this.pool.query("UPDATE runs SET sandbox_id = $2 WHERE id = $1", [runId, sandboxId]);
  }

  async markRunSucceeded(runId: string): Promise<void> {
    await this.pool.query("UPDATE runs SET status = 'succeeded', completed_at = now(), error = NULL WHERE id = $1", [runId]);
  }

  async markRunFailed(runId: string, error: string): Promise<void> {
    await this.pool.query("UPDATE runs SET status = 'failed', completed_at = now(), error = $2 WHERE id = $1", [runId, error]);
  }

  async listRuns(): Promise<RunRow[]> {
    const result = await this.pool.query<PgRunRecord>("SELECT * FROM runs ORDER BY created_at DESC");
    return result.rows.map(runFromRecord);
  }

  async getRun(id: string): Promise<RunRow | null> {
    const result = await this.pool.query<PgRunRecord>("SELECT * FROM runs WHERE id = $1", [id]);
    return result.rows[0] ? runFromRecord(result.rows[0]) : null;
  }

  async appendEvent(input: AppendEventInput): Promise<EventRow> {
    const result = await this.pool.query<PgEventRecord>(
      [
        "INSERT INTO events (id, task_id, run_id, type, source, message, data_json)",
        "VALUES ($1, $2, $3, $4, $5, $6, $7)",
        "RETURNING *",
      ].join(" "),
      [
        randomUUID(),
        input.taskId,
        input.runId ?? null,
        input.type,
        input.source,
        input.message ?? null,
        input.data ?? null,
      ],
    );
    return eventFromRecord(result.rows[0]);
  }

  async listEvents(filter: EventFilter): Promise<EventRow[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filter.taskId) {
      values.push(filter.taskId);
      where.push(`task_id = $${values.length}`);
    }
    if (filter.runId) {
      values.push(filter.runId);
      where.push(`run_id = $${values.length}`);
    }
    if (filter.after !== undefined) {
      values.push(filter.after);
      where.push(`seq > $${values.length}`);
    }
    values.push(Math.min(filter.limit ?? 100, 500));
    const sql = [
      "SELECT * FROM events",
      where.length ? `WHERE ${where.join(" AND ")}` : "",
      "ORDER BY seq ASC",
      `LIMIT $${values.length}`,
    ].join(" ");
    const result = await this.pool.query<PgEventRecord>(sql, values);
    return result.rows.map(eventFromRecord);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export class MemoryTaskRepository implements TaskRepository {
  private readonly tasks: TaskRow[] = [];
  private readonly runs: RunRow[] = [];
  private readonly events: EventRow[] = [];
  private nextSeq = 1;

  async createTask(input: CreateTaskInput): Promise<TaskRow> {
    const task: TaskRow = {
      id: randomUUID(),
      status: "queued",
      spec: structuredClone(input.spec),
      createdAt: nowIso(),
      startedAt: null,
      completedAt: null,
      error: null,
    };
    this.tasks.push(task);
    return structuredClone(task);
  }

  async listTasks(): Promise<TaskRow[]> {
    return this.tasks.slice().reverse().map((task) => structuredClone(task));
  }

  async getTask(id: string): Promise<TaskRow | null> {
    const task = this.tasks.find((row) => row.id === id);
    return task ? structuredClone(task) : null;
  }

  async claimNextTask(): Promise<TaskRow | null> {
    const task = this.tasks.find((row) => row.status === "queued");
    if (!task) return null;
    task.status = "claimed";
    return structuredClone(task);
  }

  async markTaskRunning(id: string): Promise<void> {
    const task = mustFind(this.tasks, id);
    task.status = "running";
    task.startedAt ??= nowIso();
  }

  async markTaskSucceeded(id: string): Promise<void> {
    const task = mustFind(this.tasks, id);
    task.status = "succeeded";
    task.completedAt = nowIso();
    task.error = null;
  }

  async markTaskFailed(id: string, error: string): Promise<void> {
    const task = mustFind(this.tasks, id);
    task.status = "failed";
    task.completedAt = nowIso();
    task.error = error;
  }

  async createRun(taskId: string): Promise<RunRow> {
    const run: RunRow = {
      id: randomUUID(),
      taskId,
      status: "running",
      sandboxId: null,
      createdAt: nowIso(),
      startedAt: nowIso(),
      completedAt: null,
      error: null,
    };
    this.runs.push(run);
    return structuredClone(run);
  }

  async setRunSandbox(runId: string, sandboxId: string): Promise<void> {
    mustFind(this.runs, runId).sandboxId = sandboxId;
  }

  async markRunSucceeded(runId: string): Promise<void> {
    const run = mustFind(this.runs, runId);
    run.status = "succeeded";
    run.completedAt = nowIso();
    run.error = null;
  }

  async markRunFailed(runId: string, error: string): Promise<void> {
    const run = mustFind(this.runs, runId);
    run.status = "failed";
    run.completedAt = nowIso();
    run.error = error;
  }

  async listRuns(): Promise<RunRow[]> {
    return this.runs.slice().reverse().map((run) => structuredClone(run));
  }

  async getRun(id: string): Promise<RunRow | null> {
    const run = this.runs.find((row) => row.id === id);
    return run ? structuredClone(run) : null;
  }

  async appendEvent(input: AppendEventInput): Promise<EventRow> {
    const event: EventRow = {
      id: randomUUID(),
      seq: this.nextSeq++,
      taskId: input.taskId,
      runId: input.runId ?? null,
      type: input.type,
      source: input.source,
      message: input.message ?? null,
      data: input.data ?? null,
      createdAt: nowIso(),
    };
    this.events.push(event);
    return structuredClone(event);
  }

  async listEvents(filter: EventFilter): Promise<EventRow[]> {
    return this.events
      .filter((event) => !filter.taskId || event.taskId === filter.taskId)
      .filter((event) => !filter.runId || event.runId === filter.runId)
      .filter((event) => filter.after === undefined || event.seq > filter.after)
      .slice(0, Math.min(filter.limit ?? 100, 500))
      .map((event) => structuredClone(event));
  }

  async close(): Promise<void> {}
}

const taskFromRecord = (row: PgTaskRecord): TaskRow => ({
  id: row.id,
  status: row.status,
  spec: row.spec_json,
  createdAt: row.created_at.toISOString(),
  startedAt: row.started_at?.toISOString() ?? null,
  completedAt: row.completed_at?.toISOString() ?? null,
  error: row.error,
});

const runFromRecord = (row: PgRunRecord): RunRow => ({
  id: row.id,
  taskId: row.task_id,
  status: row.status,
  sandboxId: row.sandbox_id,
  createdAt: row.created_at.toISOString(),
  startedAt: row.started_at?.toISOString() ?? null,
  completedAt: row.completed_at?.toISOString() ?? null,
  error: row.error,
});

const eventFromRecord = (row: PgEventRecord): EventRow => ({
  id: row.id,
  seq: Number(row.seq),
  taskId: row.task_id,
  runId: row.run_id,
  type: row.type,
  source: row.source,
  message: row.message,
  data: row.data_json,
  createdAt: row.created_at.toISOString(),
});

const nowIso = (): string => new Date().toISOString();

const mustFind = <T extends { id: string }>(rows: T[], id: string): T => {
  const row = rows.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`row not found: ${id}`);
  return row;
};
