import fs from "node:fs";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";

import { nextTickIso, nowIso } from "./time.js";
import type {
  HeartbeatEventRow,
  HeartbeatRow,
  HeartbeatRunRow,
  HeartbeatStatus,
  RunStatus,
  SessionRow,
} from "./types.js";

type SqlValue = string | number | null;

export type HeartbeatUpdateInput = {
  title: string;
  cadence: number;
  contents: string;
  provider: string;
  model: string;
  status: HeartbeatStatus;
};

export type AgentRunKind = "run" | "edit";

export type AgentRow = {
  id: string;
  name: string;
  repo_url: string;
  current_version: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

export type AgentRunRow = {
  id: string;
  agent_id: string;
  kind: AgentRunKind;
  input_branch: string;
  run_branch: string;
  output_branch: string | null;
  status: string;
  objective: string;
  created_at: string;
  updated_at: string;
};

export type AgentEventRow = {
  id: string;
  agent_id: string;
  run_id: string | null;
  type: string;
  message: string | null;
  data: string | null;
  created_at: string;
};

export class Database {
  private readonly client: Client;

  constructor(
    private readonly dbUrl: string,
    private readonly schemaPath: string,
    authToken?: string,
  ) {
    if (dbUrl.startsWith("file:")) {
      const filePath = dbUrl.slice("file:".length);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    this.client = createClient({ url: dbUrl, authToken });
  }

  async close(): Promise<void> {
    this.client.close();
  }

  async initSchema(): Promise<void> {
    const schema = fs.readFileSync(this.schemaPath, "utf8");
    for (const statement of splitSql(schema)) {
      await this.client.execute(statement);
    }
    await this.ensureHeartbeatColumns();
  }

  async createSession(name: string): Promise<SessionRow> {
    const id = randomId("ses");
    await this.client.execute({
      sql: "INSERT INTO sessions (id, name, status) VALUES (?, ?, 'active')",
      args: [id, name],
    });
    const row = await this.getSession(id);
    if (!row) throw new Error("created session could not be loaded");
    return row;
  }

  async getSession(id: string): Promise<SessionRow | null> {
    return this.first<SessionRow>(
      "SELECT id, name, status, created_at, updated_at FROM sessions WHERE id = ?",
      [id],
    );
  }

  async listSessions(): Promise<SessionRow[]> {
    return this.all<SessionRow>(
      "SELECT id, name, status, created_at, updated_at FROM sessions ORDER BY created_at DESC",
    );
  }

  async createHeartbeat(input: {
    sessionId: string;
    title: string;
    cadence: number;
    contents: string;
    provider: string;
    model: string;
    status: HeartbeatStatus;
  }): Promise<HeartbeatRow> {
    const id = randomId("hb");
    await this.client.execute({
      sql: `
        INSERT INTO heartbeats (
          id, session_id, title, cadence, contents, provider, model, last_tick, next_tick, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        id,
        input.sessionId,
        input.title,
        input.cadence,
        input.contents,
        input.provider,
        input.model,
        null,
        nextTickIso(input.cadence, input.status),
        input.status,
      ],
    });
    const row = await this.getHeartbeat(id);
    if (!row) throw new Error("created heartbeat could not be loaded");
    return row;
  }

  async getHeartbeat(id: string): Promise<HeartbeatRow | null> {
    return this.first<HeartbeatRow>(
      `
        SELECT id, session_id, title, cadence, contents, provider, model, last_tick, next_tick,
               status, created_at, updated_at
        FROM heartbeats
        WHERE id = ?
      `,
      [id],
    );
  }

  async listHeartbeats(sessionId?: string): Promise<HeartbeatRow[]> {
    if (sessionId) {
      return this.all<HeartbeatRow>(
        `
          SELECT id, session_id, title, cadence, contents, last_tick, next_tick,
                 provider, model, status, created_at, updated_at
          FROM heartbeats
          WHERE session_id = ?
          ORDER BY created_at DESC
        `,
        [sessionId],
      );
    }
    return this.all<HeartbeatRow>(
      `
        SELECT id, session_id, title, cadence, contents, provider, model, last_tick, next_tick,
               status, created_at, updated_at
        FROM heartbeats
        ORDER BY created_at DESC
      `,
    );
  }

  async updateHeartbeat(
    id: string,
    input: HeartbeatUpdateInput,
  ): Promise<HeartbeatRow | null> {
    await this.client.execute({
      sql: `
        UPDATE heartbeats
        SET title = ?, cadence = ?, contents = ?, provider = ?, model = ?, next_tick = ?,
            status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      args: [
        input.title,
        input.cadence,
        input.contents,
        input.provider,
        input.model,
        nextTickIso(input.cadence, input.status),
        input.status,
        id,
      ],
    });
    return this.getHeartbeat(id);
  }

  async tickHeartbeat(id: string): Promise<HeartbeatRow | null> {
    const heartbeat = await this.getHeartbeat(id);
    if (!heartbeat) return null;
    await this.client.execute({
      sql: `
        UPDATE heartbeats
        SET last_tick = ?, next_tick = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      args: [nowIso(), nextTickIso(heartbeat.cadence, heartbeat.status), id],
    });
    return this.getHeartbeat(id);
  }

  async listDueHeartbeats(limit: number): Promise<HeartbeatRow[]> {
    return this.all<HeartbeatRow>(
      `
        SELECT id, session_id, title, cadence, contents, provider, model, last_tick, next_tick,
               status, created_at, updated_at
        FROM heartbeats
        WHERE status = 'active'
          AND (next_tick IS NULL OR next_tick <= ?)
        ORDER BY COALESCE(next_tick, created_at) ASC, created_at ASC
        LIMIT ?
      `,
      [nowIso(), limit],
    );
  }

  async createRun(input: {
    heartbeatId: string;
    sessionId: string;
    executor: string;
    model: string | null;
    status: RunStatus;
    promptSnapshot: string;
    output: string | null;
    error: string | null;
  }): Promise<HeartbeatRunRow> {
    const id = randomId("run");
    await this.client.execute({
      sql: `
        INSERT INTO heartbeat_runs (
          id, heartbeat_id, session_id, executor, model, status,
          prompt_snapshot, output, error, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        id,
        input.heartbeatId,
        input.sessionId,
        input.executor,
        input.model,
        input.status,
        input.promptSnapshot,
        input.output,
        input.error,
        nowIso(),
      ],
    });
    const row = await this.getRun(id);
    if (!row) throw new Error("created run could not be loaded");
    return row;
  }

  async createEvent(input: {
    heartbeatId?: string | null;
    runId?: string | null;
    sessionId?: string | null;
    source: string;
    type: string;
    message?: string | null;
    data?: unknown;
  }): Promise<HeartbeatEventRow> {
    const id = randomId("evt");
    await this.client.execute({
      sql: `
        INSERT INTO heartbeat_events (
          id, heartbeat_id, run_id, session_id, source, type, message, data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        id,
        input.heartbeatId ?? null,
        input.runId ?? null,
        input.sessionId ?? null,
        input.source,
        input.type,
        input.message ?? null,
        input.data === undefined ? null : JSON.stringify(input.data),
      ],
    });
    const row = await this.getEvent(id);
    if (!row) throw new Error("created event could not be loaded");
    return row;
  }

  async getEvent(id: string): Promise<HeartbeatEventRow | null> {
    return this.first<HeartbeatEventRow>(
      `
        SELECT id, heartbeat_id, run_id, session_id, source, type, message, data, created_at
        FROM heartbeat_events
        WHERE id = ?
      `,
      [id],
    );
  }

  async listEvents(filters: {
    heartbeatId?: string;
    runId?: string;
    sessionId?: string;
    limit?: number;
  }): Promise<HeartbeatEventRow[]> {
    const conditions: string[] = [];
    const args: SqlValue[] = [];
    if (filters.heartbeatId) {
      conditions.push("heartbeat_id = ?");
      args.push(filters.heartbeatId);
    }
    if (filters.runId) {
      conditions.push("run_id = ?");
      args.push(filters.runId);
    }
    if (filters.sessionId) {
      conditions.push("session_id = ?");
      args.push(filters.sessionId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    args.push(filters.limit ?? 100);
    return this.all<HeartbeatEventRow>(
      `
        SELECT id, heartbeat_id, run_id, session_id, source, type, message, data, created_at
        FROM heartbeat_events
        ${where}
        ORDER BY created_at DESC
        LIMIT ?
      `,
      args,
    );
  }

  async getRun(id: string): Promise<HeartbeatRunRow | null> {
    return this.first<HeartbeatRunRow>(
      `
        SELECT id, heartbeat_id, session_id, executor, model, status,
               prompt_snapshot, output, error, created_at, completed_at
        FROM heartbeat_runs
        WHERE id = ?
      `,
      [id],
    );
  }

  async listRuns(filters: {
    heartbeatId?: string;
    sessionId?: string;
  }): Promise<HeartbeatRunRow[]> {
    const conditions: string[] = [];
    const args: SqlValue[] = [];
    if (filters.heartbeatId) {
      conditions.push("heartbeat_id = ?");
      args.push(filters.heartbeatId);
    }
    if (filters.sessionId) {
      conditions.push("session_id = ?");
      args.push(filters.sessionId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.all<HeartbeatRunRow>(
      `
        SELECT id, heartbeat_id, session_id, executor, model, status,
               prompt_snapshot, output, error, created_at, completed_at
        FROM heartbeat_runs
        ${where}
        ORDER BY created_at DESC
      `,
      args,
    );
  }

  async createAgent(input: {
    id?: string;
    name: string;
    repoUrl: string;
    currentVersion?: string | null;
    status?: string;
  }): Promise<AgentRow> {
    const id = input.id ?? randomId("agt");
    await this.client.execute({
      sql: `
        INSERT INTO agents (id, name, repo_url, current_version, status)
        VALUES (?, ?, ?, ?, ?)
      `,
      args: [
        id,
        input.name,
        input.repoUrl,
        input.currentVersion ?? null,
        input.status ?? "active",
      ],
    });
    const row = await this.getAgent(id);
    if (!row) throw new Error("created agent could not be loaded");
    return row;
  }

  async listAgents(): Promise<AgentRow[]> {
    return this.all<AgentRow>(
      `
        SELECT id, name, repo_url, current_version, status, created_at, updated_at
        FROM agents
        ORDER BY created_at DESC
      `,
    );
  }

  async getAgent(id: string): Promise<AgentRow | null> {
    return this.first<AgentRow>(
      `
        SELECT id, name, repo_url, current_version, status, created_at, updated_at
        FROM agents
        WHERE id = ?
      `,
      [id],
    );
  }

  async updateAgentCurrentVersion(
    id: string,
    currentVersion: string | null,
  ): Promise<AgentRow | null> {
    await this.client.execute({
      sql: `
        UPDATE agents
        SET current_version = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      args: [currentVersion, id],
    });
    return this.getAgent(id);
  }

  async createAgentRun(input: {
    id?: string;
    agentId: string;
    kind: AgentRunKind;
    inputBranch: string;
    runBranch: string;
    outputBranch?: string | null;
    status?: string;
    objective: string;
  }): Promise<AgentRunRow> {
    const id = input.id ?? randomId("arun");
    await this.client.execute({
      sql: `
        INSERT INTO agent_runs (
          id, agent_id, kind, input_branch, run_branch, output_branch, status, objective
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        id,
        input.agentId,
        input.kind,
        input.inputBranch,
        input.runBranch,
        input.outputBranch ?? null,
        input.status ?? "queued",
        input.objective,
      ],
    });
    const row = await this.getAgentRun(id);
    if (!row) throw new Error("created agent run could not be loaded");
    return row;
  }

  async getAgentRun(id: string): Promise<AgentRunRow | null> {
    return this.first<AgentRunRow>(
      `
        SELECT id, agent_id, kind, input_branch, run_branch, output_branch, status,
               objective, created_at, updated_at
        FROM agent_runs
        WHERE id = ?
      `,
      [id],
    );
  }

  async listAgentRuns(agentId: string): Promise<AgentRunRow[]> {
    return this.all<AgentRunRow>(
      `
        SELECT id, agent_id, kind, input_branch, run_branch, output_branch, status,
               objective, created_at, updated_at
        FROM agent_runs
        WHERE agent_id = ?
        ORDER BY created_at DESC
      `,
      [agentId],
    );
  }

  async updateAgentRunStatus(
    id: string,
    status: string,
  ): Promise<AgentRunRow | null> {
    await this.client.execute({
      sql: `
        UPDATE agent_runs
        SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      args: [status, id],
    });
    return this.getAgentRun(id);
  }

  async updateAgentRunOutputBranch(
    id: string,
    outputBranch: string | null,
  ): Promise<AgentRunRow | null> {
    await this.client.execute({
      sql: `
        UPDATE agent_runs
        SET output_branch = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      args: [outputBranch, id],
    });
    return this.getAgentRun(id);
  }

  async appendAgentEvent(input: {
    id?: string;
    agentId: string;
    runId?: string | null;
    type: string;
    message?: string | null;
    data?: unknown;
  }): Promise<AgentEventRow> {
    const id = input.id ?? randomId("aevt");
    await this.client.execute({
      sql: `
        INSERT INTO agent_events (id, agent_id, run_id, type, message, data)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      args: [
        id,
        input.agentId,
        input.runId ?? null,
        input.type,
        input.message ?? null,
        input.data === undefined ? null : JSON.stringify(input.data),
      ],
    });
    const row = await this.getAgentEvent(id);
    if (!row) throw new Error("created agent event could not be loaded");
    return row;
  }

  async listAgentEvents(filters: {
    agentId?: string;
    runId?: string;
    limit?: number;
  }): Promise<AgentEventRow[]> {
    const conditions: string[] = [];
    const args: SqlValue[] = [];
    if (filters.agentId) {
      conditions.push("agent_id = ?");
      args.push(filters.agentId);
    }
    if (filters.runId) {
      conditions.push("run_id = ?");
      args.push(filters.runId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    args.push(filters.limit ?? 100);
    return this.all<AgentEventRow>(
      `
        SELECT id, agent_id, run_id, type, message, data, created_at
        FROM agent_events
        ${where}
        ORDER BY created_at DESC
        LIMIT ?
      `,
      args,
    );
  }

  private async getAgentEvent(id: string): Promise<AgentEventRow | null> {
    return this.first<AgentEventRow>(
      `
        SELECT id, agent_id, run_id, type, message, data, created_at
        FROM agent_events
        WHERE id = ?
      `,
      [id],
    );
  }

  private async first<T>(sql: string, args: SqlValue[] = []): Promise<T | null> {
    const result = await this.client.execute({ sql, args });
    return (result.rows[0] as T | undefined) ?? null;
  }

  private async all<T>(sql: string, args: SqlValue[] = []): Promise<T[]> {
    const result = await this.client.execute({ sql, args });
    return result.rows as T[];
  }

  private async ensureHeartbeatColumns(): Promise<void> {
    const columns = await this.all<{ name: string }>("PRAGMA table_info(heartbeats)");
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("provider")) {
      await this.client.execute(
        "ALTER TABLE heartbeats ADD COLUMN provider TEXT NOT NULL DEFAULT 'deepseek'",
      );
    }
    if (!names.has("model")) {
      await this.client.execute(
        "ALTER TABLE heartbeats ADD COLUMN model TEXT NOT NULL DEFAULT 'deepseek-v4-flash'",
      );
    }
  }
}

const randomId = (prefix: string): string => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

const splitSql = (schema: string): string[] =>
  schema
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
