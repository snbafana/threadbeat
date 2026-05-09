import fs from "node:fs";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";

import { nextTickIso, nowIso } from "./time.js";
import type {
  AgentRow,
  AgentRunRow,
  HeartbeatRow,
  HostedGitRepoRow,
  MessageRow,
  SandboxRow,
} from "./types.js";

type SqlValue = string | number | null;

export class Database {
  private readonly client: Client;

  constructor(
    private readonly dbUrl: string,
    private readonly schemaPath: string,
  ) {
    if (dbUrl.startsWith("file:")) {
      fs.mkdirSync(path.dirname(dbUrl.slice("file:".length)), { recursive: true });
    }
    this.client = createClient({ url: dbUrl });
  }

  async close(): Promise<void> {
    this.client.close();
  }

  async initSchema(): Promise<void> {
    const schema = fs.readFileSync(this.schemaPath, "utf8");
    for (const statement of splitSql(schema)) {
      await this.client.execute(statement);
    }
    await this.ensureAgentColumns();
    await this.ensureHostedGitRepoColumns();
    await this.ensureAgentRunColumns();
    await this.ensureSandboxColumns();
  }

  async createAgent(input: {
    name: string;
    repoUrl: string;
    repoWebUrl?: string | null;
    defaultBranch?: string;
    currentRef?: string;
    currentCommit?: string | null;
  }): Promise<AgentRow> {
    const id = randomId("agt");
    const defaultBranch = input.defaultBranch ?? "main";
    await this.client.execute({
      sql: `
        INSERT INTO agents (
          id, name, repo_url, repo_web_url, default_branch, current_ref, current_commit
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        id,
        input.name,
        input.repoUrl,
        input.repoWebUrl ?? null,
        defaultBranch,
        input.currentRef ?? defaultBranch,
        input.currentCommit ?? null,
      ],
    });
    return this.mustGetAgent(id);
  }

  async listAgents(): Promise<AgentRow[]> {
    return this.all<AgentRow>(
      `
        SELECT id, name, repo_url, repo_web_url, default_branch, current_ref, current_commit,
               status, created_at, updated_at
        FROM agents
        ORDER BY created_at DESC
      `,
    );
  }

  async getAgent(id: string): Promise<AgentRow | null> {
    return this.first<AgentRow>(
      `
        SELECT id, name, repo_url, repo_web_url, default_branch, current_ref, current_commit,
               status, created_at, updated_at
        FROM agents
        WHERE id = ?
      `,
      [id],
    );
  }

  async createAgentRun(input: {
    id?: string;
    agentId: string;
    kind?: string;
    objective: string;
    inputRef: string;
    runBranch: string;
    baseCommit?: string | null;
    status?: string;
  }): Promise<AgentRunRow> {
    const id = input.id ?? randomId("run");
    await this.client.execute({
      sql: `
        INSERT INTO agent_runs (
          id, agent_id, kind, objective, input_ref, run_branch, base_commit, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        id,
        input.agentId,
        input.kind ?? "run",
        input.objective,
        input.inputRef,
        input.runBranch,
        input.baseCommit ?? null,
        input.status ?? "queued",
      ],
    });
    return this.mustGetAgentRun(id);
  }

  async getAgentRun(id: string): Promise<AgentRunRow | null> {
    return this.first<AgentRunRow>(
      `
        SELECT id, agent_id, kind, objective, input_ref, run_branch, base_commit, result_commit,
               status, result_summary, started_at, completed_at, created_at, updated_at
        FROM agent_runs
        WHERE id = ?
      `,
      [id],
    );
  }

  async listAgentRuns(agentId: string): Promise<AgentRunRow[]> {
    return this.all<AgentRunRow>(
      `
        SELECT id, agent_id, kind, objective, input_ref, run_branch, base_commit, result_commit,
               status, result_summary, started_at, completed_at, created_at, updated_at
        FROM agent_runs
        WHERE agent_id = ?
        ORDER BY created_at DESC
      `,
      [agentId],
    );
  }

  async updateAgentRunStarted(id: string): Promise<AgentRunRow> {
    await this.client.execute({
      sql: `
        UPDATE agent_runs
        SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      args: [nowIso(), id],
    });
    return this.mustGetAgentRun(id);
  }

  async updateAgentRunRestarted(id: string): Promise<AgentRunRow> {
    await this.client.execute({
      sql: `
        UPDATE agent_runs
        SET status = 'running', result_summary = NULL, completed_at = NULL,
            started_at = COALESCE(started_at, ?), updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      args: [nowIso(), id],
    });
    return this.mustGetAgentRun(id);
  }

  async updateAgentRunCompleted(input: {
    id: string;
    status: string;
    resultCommit?: string | null;
    resultSummary?: string | null;
  }): Promise<AgentRunRow> {
    await this.client.execute({
      sql: `
        UPDATE agent_runs
        SET status = ?, result_commit = ?, result_summary = ?, completed_at = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      args: [
        input.status,
        input.resultCommit ?? null,
        input.resultSummary ?? null,
        nowIso(),
        input.id,
      ],
    });
    return this.mustGetAgentRun(input.id);
  }

  async updateAgentRunFailed(input: {
    id: string;
    resultSummary: string;
  }): Promise<AgentRunRow> {
    await this.client.execute({
      sql: `
        UPDATE agent_runs
        SET status = 'failed', result_summary = ?, completed_at = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      args: [input.resultSummary, nowIso(), input.id],
    });
    return this.mustGetAgentRun(input.id);
  }

  async createHostedGitRepo(input: {
    agentId: string;
    provider?: string;
    owner: string;
    repo: string;
    defaultBranch: string;
    remoteUrlRedacted?: string | null;
    status?: string;
  }): Promise<HostedGitRepoRow> {
    const id = randomId("hgr");
    await this.client.execute({
      sql: `
        INSERT INTO hosted_git_repos (
          id, agent_id, provider, owner, repo, default_branch, remote_url_redacted, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        id,
        input.agentId,
        input.provider ?? "github",
        input.owner,
        input.repo,
        input.defaultBranch,
        input.remoteUrlRedacted ?? null,
        input.status ?? "active",
      ],
    });
    return this.mustGetHostedGitRepo(id);
  }

  async getHostedGitRepo(id: string): Promise<HostedGitRepoRow | null> {
    return this.first<HostedGitRepoRow>(
      `
        SELECT id, agent_id, provider, owner, repo, default_branch, remote_url_redacted,
               status, created_at, updated_at
        FROM hosted_git_repos
        WHERE id = ?
      `,
      [id],
    );
  }

  async getHostedGitRepoForAgent(agentId: string): Promise<HostedGitRepoRow | null> {
    return this.first<HostedGitRepoRow>(
      `
        SELECT id, agent_id, provider, owner, repo, default_branch, remote_url_redacted,
               status, created_at, updated_at
        FROM hosted_git_repos
        WHERE agent_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [agentId],
    );
  }

  async listHostedGitRepos(): Promise<HostedGitRepoRow[]> {
    return this.all<HostedGitRepoRow>(
      `
        SELECT id, agent_id, provider, owner, repo, default_branch, remote_url_redacted,
               status, created_at, updated_at
        FROM hosted_git_repos
        ORDER BY created_at DESC
      `,
    );
  }

  async createHeartbeat(input: {
    agentId: string;
    title: string;
    cadenceSeconds: number;
    action: string;
    status?: string;
  }): Promise<HeartbeatRow> {
    const id = randomId("hb");
    const status = input.status ?? "active";
    await this.client.execute({
      sql: `
        INSERT INTO heartbeats (
          id, agent_id, title, cadence_seconds, action, status, next_tick
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        id,
        input.agentId,
        input.title,
        input.cadenceSeconds,
        input.action,
        status,
        nextTickIso(input.cadenceSeconds, status),
      ],
    });
    const heartbeat = await this.getHeartbeat(id);
    if (!heartbeat) throw new Error("created heartbeat could not be loaded");
    return heartbeat;
  }

  async listHeartbeats(agentId?: string): Promise<HeartbeatRow[]> {
    if (agentId) {
      return this.all<HeartbeatRow>(
        `
          SELECT id, agent_id, title, cadence_seconds, action, status, last_tick, next_tick,
                 created_at, updated_at
          FROM heartbeats
          WHERE agent_id = ?
          ORDER BY created_at DESC
        `,
        [agentId],
      );
    }
    return this.all<HeartbeatRow>(
      `
        SELECT id, agent_id, title, cadence_seconds, action, status, last_tick, next_tick,
               created_at, updated_at
        FROM heartbeats
        ORDER BY created_at DESC
      `,
    );
  }

  async getHeartbeat(id: string): Promise<HeartbeatRow | null> {
    return this.first<HeartbeatRow>(
      `
        SELECT id, agent_id, title, cadence_seconds, action, status, last_tick, next_tick,
               created_at, updated_at
        FROM heartbeats
        WHERE id = ?
      `,
      [id],
    );
  }

  async createSandbox(input: {
    agentId: string;
    runId?: string | null;
    repoUrl: string;
    branch: string;
    workdir?: string;
  }): Promise<SandboxRow> {
    const id = randomId("sbx");
    await this.client.execute({
      sql: `
        INSERT INTO sandboxes (id, agent_id, run_id, repo_url, branch, workdir)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      args: [id, input.agentId, input.runId ?? null, input.repoUrl, input.branch, input.workdir ?? "/workspace/agent"],
    });
    return this.mustGetSandbox(id);
  }

  async listSandboxes(filters: { agentId?: string; runId?: string } = {}): Promise<SandboxRow[]> {
    const args: SqlValue[] = [];
    const conditions: string[] = [];
    if (filters.agentId) {
      conditions.push("agent_id = ?");
      args.push(filters.agentId);
    }
    if (filters.runId) {
      conditions.push("run_id = ?");
      args.push(filters.runId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.all<SandboxRow>(
      `
        SELECT id, agent_id, run_id, provider, provider_sandbox_id, state, repo_url, branch, workdir,
               started_at, stopped_at, created_at, updated_at
        FROM sandboxes
        ${where}
        ORDER BY started_at DESC, created_at DESC
      `,
      args,
    );
  }

  async getSandbox(id: string): Promise<SandboxRow | null> {
    return this.first<SandboxRow>(
      `
        SELECT id, agent_id, run_id, provider, provider_sandbox_id, state, repo_url, branch, workdir,
               started_at, stopped_at, created_at, updated_at
        FROM sandboxes
        WHERE id = ?
      `,
      [id],
    );
  }

  async updateSandboxStarted(id: string, providerSandboxId: string): Promise<SandboxRow> {
    await this.client.execute({
      sql: `
        UPDATE sandboxes
        SET provider_sandbox_id = ?, state = 'running', started_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      args: [providerSandboxId, nowIso(), id],
    });
    return this.mustGetSandbox(id);
  }

  async updateSandboxState(id: string, state: string): Promise<SandboxRow> {
    await this.client.execute({
      sql: `
        UPDATE sandboxes
        SET state = ?, stopped_at = CASE WHEN ? IN ('stopped', 'failed') THEN ? ELSE stopped_at END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      args: [state, state, nowIso(), id],
    });
    return this.mustGetSandbox(id);
  }

  async appendMessage(input: {
    agentId?: string | null;
    sandboxId?: string | null;
    runId?: string | null;
    source: string;
    type: string;
    text?: string | null;
    data?: unknown;
  }): Promise<MessageRow> {
    const id = randomId("msg");
    await this.client.execute({
      sql: `
        INSERT INTO messages (id, agent_id, sandbox_id, run_id, source, type, text, data_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        id,
        input.agentId ?? null,
        input.sandboxId ?? null,
        input.runId ?? null,
        input.source,
        input.type,
        input.text ?? null,
        input.data === undefined ? null : JSON.stringify(input.data),
      ],
    });
    const message = await this.getMessage(id);
    if (!message) throw new Error("created message could not be loaded");
    return message;
  }

  async listMessages(filters: {
    agentId?: string;
    runId?: string;
    sandboxId?: string;
    limit?: number;
  }): Promise<MessageRow[]> {
    const conditions: string[] = [];
    const args: SqlValue[] = [];
    if (filters.agentId) {
      conditions.push("agent_id = ?");
      args.push(filters.agentId);
    }
    if (filters.sandboxId) {
      conditions.push("sandbox_id = ?");
      args.push(filters.sandboxId);
    }
    if (filters.runId) {
      conditions.push("run_id = ?");
      args.push(filters.runId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    args.push(filters.limit ?? 100);
    return this.all<MessageRow>(
      `
        SELECT id, agent_id, sandbox_id, run_id, source, type, text, data_json, created_at
        FROM messages
        ${where}
        ORDER BY created_at DESC
        LIMIT ?
      `,
      args,
    );
  }

  private async mustGetAgent(id: string): Promise<AgentRow> {
    const agent = await this.getAgent(id);
    if (!agent) throw new Error(`agent not found after write: ${id}`);
    return agent;
  }

  private async mustGetSandbox(id: string): Promise<SandboxRow> {
    const sandbox = await this.getSandbox(id);
    if (!sandbox) throw new Error(`sandbox not found after write: ${id}`);
    return sandbox;
  }

  private async mustGetAgentRun(id: string): Promise<AgentRunRow> {
    const run = await this.getAgentRun(id);
    if (!run) throw new Error(`agent run not found after write: ${id}`);
    return run;
  }

  private async mustGetHostedGitRepo(id: string): Promise<HostedGitRepoRow> {
    const repo = await this.getHostedGitRepo(id);
    if (!repo) throw new Error(`hosted Git repo not found after write: ${id}`);
    return repo;
  }

  private async getMessage(id: string): Promise<MessageRow | null> {
    return this.first<MessageRow>(
      `
        SELECT id, agent_id, sandbox_id, run_id, source, type, text, data_json, created_at
        FROM messages
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

  private async ensureAgentColumns(): Promise<void> {
    const names = await this.tableColumnNames("agents");
    if (!names.has("repo_web_url")) {
      await this.client.execute("ALTER TABLE agents ADD COLUMN repo_web_url TEXT");
    }
    if (!names.has("default_branch")) {
      await this.client.execute("ALTER TABLE agents ADD COLUMN default_branch TEXT NOT NULL DEFAULT 'main'");
    }
    if (!names.has("current_ref")) {
      await this.client.execute("ALTER TABLE agents ADD COLUMN current_ref TEXT NOT NULL DEFAULT 'main'");
    }
    if (!names.has("current_commit")) {
      await this.client.execute("ALTER TABLE agents ADD COLUMN current_commit TEXT");
    }
  }

  private async ensureAgentRunColumns(): Promise<void> {
    const names = await this.tableColumnNames("agent_runs");
    if (!names.has("objective")) {
      await this.client.execute("ALTER TABLE agent_runs ADD COLUMN objective TEXT NOT NULL DEFAULT ''");
    }
    if (!names.has("input_ref")) {
      await this.client.execute("ALTER TABLE agent_runs ADD COLUMN input_ref TEXT NOT NULL DEFAULT ''");
    }
    if (!names.has("base_commit")) {
      await this.client.execute("ALTER TABLE agent_runs ADD COLUMN base_commit TEXT");
    }
    if (!names.has("result_commit")) {
      await this.client.execute("ALTER TABLE agent_runs ADD COLUMN result_commit TEXT");
    }
    if (!names.has("result_summary")) {
      await this.client.execute("ALTER TABLE agent_runs ADD COLUMN result_summary TEXT");
    }
    if (!names.has("started_at")) {
      await this.client.execute("ALTER TABLE agent_runs ADD COLUMN started_at TEXT");
    }
    if (!names.has("completed_at")) {
      await this.client.execute("ALTER TABLE agent_runs ADD COLUMN completed_at TEXT");
    }
  }

  private async ensureSandboxColumns(): Promise<void> {
    const names = await this.tableColumnNames("sandboxes");
    if (!names.has("run_id")) {
      await this.client.execute("ALTER TABLE sandboxes ADD COLUMN run_id TEXT");
    }
    await this.client.execute("CREATE INDEX IF NOT EXISTS idx_sandboxes_run_id ON sandboxes(run_id, created_at DESC)");
  }

  private async ensureHostedGitRepoColumns(): Promise<void> {
    const names = await this.tableColumnNames("hosted_git_repos");
    if (!names.has("provider")) {
      await this.client.execute("ALTER TABLE hosted_git_repos ADD COLUMN provider TEXT NOT NULL DEFAULT 'github'");
    }
    if (!names.has("owner")) {
      await this.client.execute("ALTER TABLE hosted_git_repos ADD COLUMN owner TEXT NOT NULL DEFAULT ''");
    }
    if (!names.has("repo")) {
      await this.client.execute("ALTER TABLE hosted_git_repos ADD COLUMN repo TEXT NOT NULL DEFAULT ''");
    }
    if (!names.has("default_branch")) {
      await this.client.execute("ALTER TABLE hosted_git_repos ADD COLUMN default_branch TEXT NOT NULL DEFAULT 'main'");
    }
    if (!names.has("remote_url_redacted")) {
      await this.client.execute("ALTER TABLE hosted_git_repos ADD COLUMN remote_url_redacted TEXT");
    }
  }

  private async tableColumnNames(tableName: string): Promise<Set<string>> {
    const columns = await this.all<{ name: string }>(`PRAGMA table_info(${tableName})`);
    return new Set(columns.map((column) => column.name));
  }
}

const splitSql = (schema: string): string[] =>
  schema
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);

const randomId = (prefix: string): string => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
