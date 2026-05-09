import fs from "node:fs";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";

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
  }

  async createAgent(input: {
    name: string;
    repoUrl: string;
    currentRef?: string;
  }): Promise<AgentRow> {
    const id = randomId("agt");
    const currentRef = input.currentRef ?? "main";
    await this.client.execute({
      sql: `
        INSERT INTO agents (
          id, name, repo_url, current_ref
        ) VALUES (?, ?, ?, ?)
      `,
      args: [
        id,
        input.name,
        input.repoUrl,
        currentRef,
      ],
    });
    return {
      id,
      name: input.name,
      repo_url: input.repoUrl,
      current_ref: currentRef,
    };
  }

  async listAgents(): Promise<AgentRow[]> {
    return this.all<AgentRow>(
      `
        SELECT id, name, repo_url, current_ref
        FROM agents
      `,
    );
  }

  async getAgent(id: string): Promise<AgentRow | null> {
    return this.first<AgentRow>(
      `
        SELECT id, name, repo_url, current_ref
        FROM agents
        WHERE id = ?
      `,
      [id],
    );
  }

  async createAgentRun(input: {
    id?: string;
    agentId: string;
    objective: string;
    inputRef: string;
    runBranch: string;
  }): Promise<AgentRunRow> {
    const id = input.id ?? randomId("run");
    await this.client.execute({
      sql: `
        INSERT INTO agent_runs (
          id, agent_id, objective, input_ref, run_branch, status
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      args: [
        id,
        input.agentId,
        input.objective,
        input.inputRef,
        input.runBranch,
        "planned",
      ],
    });
    return {
      id,
      agent_id: input.agentId,
      objective: input.objective,
      input_ref: input.inputRef,
      run_branch: input.runBranch,
      result_commit: null,
      status: "planned",
    };
  }

  async getAgentRun(id: string): Promise<AgentRunRow | null> {
    return this.first<AgentRunRow>(
      `
        SELECT id, agent_id, objective, input_ref, run_branch, result_commit,
               status
        FROM agent_runs
        WHERE id = ?
      `,
      [id],
    );
  }

  async listAgentRuns(agentId: string): Promise<AgentRunRow[]> {
    return this.all<AgentRunRow>(
      `
        SELECT id, agent_id, objective, input_ref, run_branch, result_commit,
               status
        FROM agent_runs
        WHERE agent_id = ?
      `,
      [agentId],
    );
  }

  async markAgentRunRunning(id: string): Promise<void> {
    await this.client.execute({
      sql: `
        UPDATE agent_runs
        SET status = 'running'
        WHERE id = ?
      `,
      args: [id],
    });
  }

  async updateAgentRunCompleted(input: {
    id: string;
    status: string;
    resultCommit?: string | null;
  }): Promise<void> {
    await this.client.execute({
      sql: `
        UPDATE agent_runs
        SET status = ?, result_commit = ?
        WHERE id = ?
      `,
      args: [
        input.status,
        input.resultCommit ?? null,
        input.id,
      ],
    });
  }

  async updateAgentRunFailed(id: string): Promise<void> {
    await this.client.execute({
      sql: `
        UPDATE agent_runs
        SET status = 'failed'
        WHERE id = ? AND status != 'completed'
      `,
      args: [id],
    });
  }

  async createHostedGitRepo(input: {
    agentId: string;
    owner: string;
    repo: string;
  }): Promise<void> {
    await this.client.execute({
      sql: `
        INSERT INTO hosted_git_repos (
          agent_id, owner, repo
        ) VALUES (?, ?, ?)
      `,
      args: [input.agentId, input.owner, input.repo],
    });
  }

  async getHostedGitRepoForAgent(agentId: string): Promise<HostedGitRepoRow | null> {
    return this.first<HostedGitRepoRow>(
      `
        SELECT agent_id, owner, repo
        FROM hosted_git_repos
        WHERE agent_id = ?
        LIMIT 1
      `,
      [agentId],
    );
  }

  async listHostedGitRepos(): Promise<HostedGitRepoRow[]> {
    return this.all<HostedGitRepoRow>(
      `
        SELECT agent_id, owner, repo
        FROM hosted_git_repos
        ORDER BY agent_id
      `,
    );
  }

  async createHeartbeat(input: {
    agentId: string;
    title: string;
  }): Promise<HeartbeatRow> {
    const id = randomId("hb");
    await this.client.execute({
      sql: `
        INSERT INTO heartbeats (
          id, agent_id, title
        ) VALUES (?, ?, ?)
      `,
      args: [
        id,
        input.agentId,
        input.title,
      ],
    });
    return { id, agent_id: input.agentId, title: input.title };
  }

  async listHeartbeats(agentId?: string): Promise<HeartbeatRow[]> {
    if (agentId) {
      return this.all<HeartbeatRow>(
        `
          SELECT id, agent_id, title
          FROM heartbeats
          WHERE agent_id = ?
        `,
        [agentId],
      );
    }
    return this.all<HeartbeatRow>(
      `
        SELECT id, agent_id, title
        FROM heartbeats
      `,
    );
  }

  async getHeartbeat(id: string): Promise<HeartbeatRow | null> {
    return this.first<HeartbeatRow>(
      `
        SELECT id, agent_id, title
        FROM heartbeats
        WHERE id = ?
      `,
      [id],
    );
  }

  async createSandbox(input: {
    agentId: string;
    runId?: string | null;
  }): Promise<SandboxRow> {
    const id = randomId("sbx");
    await this.client.execute({
      sql: `
        INSERT INTO sandboxes (id, agent_id, run_id)
        VALUES (?, ?, ?)
      `,
      args: [id, input.agentId, input.runId ?? null],
    });
    return {
      id,
      agent_id: input.agentId,
      run_id: input.runId ?? null,
      provider_sandbox_id: null,
      state: "starting",
    };
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
        SELECT id, agent_id, run_id, provider_sandbox_id, state
        FROM sandboxes
        ${where}
      `,
      args,
    );
  }

  async getSandbox(id: string): Promise<SandboxRow | null> {
    return this.first<SandboxRow>(
      `
        SELECT id, agent_id, run_id, provider_sandbox_id, state
        FROM sandboxes
        WHERE id = ?
      `,
      [id],
    );
  }

  async updateSandboxStarted(id: string, providerSandboxId: string): Promise<void> {
    await this.client.execute({
      sql: `
        UPDATE sandboxes
        SET provider_sandbox_id = ?, state = 'running'
        WHERE id = ?
      `,
      args: [providerSandboxId, id],
    });
  }

  async updateSandboxState(id: string, state: string): Promise<void> {
    await this.client.execute({
      sql: `
        UPDATE sandboxes
        SET state = ?
        WHERE id = ?
      `,
      args: [state, id],
    });
  }

  async appendMessage(input: {
    agentId?: string | null;
    sandboxId?: string | null;
    runId?: string | null;
    type: string;
    text?: string | null;
  }): Promise<void> {
    await this.client.execute({
      sql: `
        INSERT INTO messages (agent_id, sandbox_id, run_id, type, text)
        VALUES (?, ?, ?, ?, ?)
      `,
      args: [
        input.agentId ?? null,
        input.sandboxId ?? null,
        input.runId ?? null,
        input.type,
        input.text ?? null,
      ],
    });
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
        SELECT agent_id, sandbox_id, run_id, type, text
        FROM messages
        ${where}
        LIMIT ?
      `,
      args,
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
}

const splitSql = (schema: string): string[] =>
  schema
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);

const randomId = (prefix: string): string => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
