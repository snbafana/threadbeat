import type { Database } from "./db.js";
import { bootstrapSandbox } from "./sandboxBootstrap.js";
import type { SandboxExecResult, SandboxProvider } from "./modalProvider.js";
import type { MessageBus } from "./messageBus.js";
import type { AgentRow, MessageRow, SandboxRow } from "./types.js";

type SandboxStartOptions = {
  runId?: string | null;
};

type SandboxExecOptions = {
  cwd?: string;
  redact?: Record<string, string>;
  timeoutMs?: number;
};

type SandboxBootstrapOptions = {
  baseRef?: string;
  pushRef?: boolean;
  repoUrl?: string;
  repoUrlRedacted?: string;
};

type SandboxFinalizeResult = {
  commitSha: string;
};

type SandboxCommandResult = SandboxExecResult & { command: string[] };

export const SANDBOX_WORKDIR = "/workspace/agent";

export class SandboxService {
  constructor(
    private readonly db: Database,
    private readonly provider: SandboxProvider,
    private readonly bus: MessageBus,
  ) {}

  async startForAgent(agent: AgentRow, options: SandboxStartOptions = {}): Promise<SandboxRow> {
    let sandbox = await this.db.createSandbox({
      agentId: agent.id,
      runId: options.runId,
    });
    await this.message({
      agentId: agent.id,
      sandboxId: sandbox.id,
      runId: options.runId,
      type: "sandbox_starting",
      text: "Starting sandbox",
    });

    try {
      const started = await this.provider.start({ sandboxName: sandbox.id });
      await this.db.updateSandboxStarted(sandbox.id, started.providerSandboxId);
      sandbox = {
        ...sandbox,
        provider_sandbox_id: started.providerSandboxId,
        state: "running",
      };
      await this.message({
        agentId: agent.id,
        sandboxId: sandbox.id,
        runId: options.runId,
        type: "sandbox_running",
        text: "Sandbox running",
      });
      return sandbox;
    } catch (error) {
      await this.db.updateSandboxState(sandbox.id, "failed");
      await this.message({
        agentId: agent.id,
        sandboxId: sandbox.id,
        runId: options.runId,
        type: "sandbox_failed",
        text: messageOf(error),
      });
      throw error;
    }
  }

  async exec(
    sandbox: SandboxRow,
    command: string[],
    options: SandboxExecOptions = {},
  ): Promise<SandboxExecResult> {
    if (!sandbox.provider_sandbox_id) throw new Error("sandbox has no provider id");
    if (sandbox.state !== "running") throw new Error(`sandbox is not running: ${sandbox.state}`);
    const redact = createRedactor(options.redact);
    const execCommand = options.cwd ? commandInCwd(command, options.cwd) : command;

    await this.message({
      agentId: sandbox.agent_id,
      sandboxId: sandbox.id,
      runId: sandbox.run_id,
      type: "exec_started",
      text: redact(execCommand.join(" ")),
    });
    const result = await this.provider.exec(sandbox.provider_sandbox_id, execCommand, { timeoutMs: options.timeoutMs });
    await this.message({
      agentId: sandbox.agent_id,
      sandboxId: sandbox.id,
      runId: sandbox.run_id,
      type: "exec_completed",
      text: result.exitCode === 0 ? "Command completed" : "Command failed",
    });
    return result;
  }

  async bootstrap(
    sandbox: SandboxRow,
    options: SandboxBootstrapOptions = {},
  ): Promise<SandboxCommandResult[]> {
    const ref = await this.sandboxRef(sandbox);
    const repoUrl = options.repoUrl ?? await this.sandboxRepoUrl(sandbox);
    const repoUrlRedacted = options.repoUrlRedacted ?? repoUrl;
    const redactMap = repoUrl === repoUrlRedacted ? undefined : { [repoUrl]: repoUrlRedacted };
    const input = {
      baseRef: options.baseRef,
      pushRef: options.pushRef,
      repoUrl,
      ref,
      workdir: SANDBOX_WORKDIR,
    };
    await this.message({
      agentId: sandbox.agent_id,
      sandboxId: sandbox.id,
      runId: sandbox.run_id,
      type: "bootstrap_started",
      text: "Bootstrapping sandbox",
    });

    try {
      const results = await bootstrapSandbox(input, async (command) => {
        return this.exec(sandbox, command, { redact: redactMap });
      });
      await this.message({
        agentId: sandbox.agent_id,
        sandboxId: sandbox.id,
        runId: sandbox.run_id,
        type: "bootstrap_completed",
        text: "Sandbox bootstrap completed",
      });
      return results;
    } catch (error) {
      await this.message({
        agentId: sandbox.agent_id,
        sandboxId: sandbox.id,
        runId: sandbox.run_id,
        type: "bootstrap_failed",
        text: messageOf(error),
      });
      throw error;
    }
  }

  async finalizeRunBranch(
    sandbox: SandboxRow,
    input: { commitMessage: string; timeoutMs?: number },
  ): Promise<SandboxFinalizeResult> {
    const commitMessage = requireNonEmpty(input.commitMessage, "commitMessage");
    const branch = await this.sandboxRef(sandbox);
    const commands = [
      ["git", "status", "--short"],
      ["git", "add", "-A"],
      ["git", "config", "user.name", "Threadbeat Agent"],
      ["git", "config", "user.email", "threadbeat-agent@users.noreply.github.com"],
      [
        "sh",
        "-lc",
        `git diff --cached --quiet || git commit -m ${shellQuote(commitMessage)}`,
      ],
      ["git", "push", "origin", `HEAD:${branch}`],
      ["git", "rev-parse", "HEAD"],
    ];

    await this.message({
      agentId: sandbox.agent_id,
      sandboxId: sandbox.id,
      runId: sandbox.run_id,
      type: "run_finalize_started",
      text: "Finalizing run branch",
    });

    const results = [];
    for (const command of commands) {
      const result = await this.exec(sandbox, command, { cwd: SANDBOX_WORKDIR, timeoutMs: input.timeoutMs });
      results.push({ command, ...result });
      if (result.exitCode !== 0) {
        await this.message({
          agentId: sandbox.agent_id,
          sandboxId: sandbox.id,
          runId: sandbox.run_id,
          type: "run_finalize_failed",
          text: `exit ${result.exitCode}`,
        });
        throw new Error(`run finalize command failed (${result.exitCode}): ${command.join(" ")}`);
      }
    }

    const commitSha = requireCommitSha(results.at(-1)?.stdout.trim() ?? "");
    await this.message({
      agentId: sandbox.agent_id,
      sandboxId: sandbox.id,
      runId: sandbox.run_id,
      type: "run_finalize_completed",
      text: "Run branch finalized",
    });
    return { commitSha };
  }

  async stop(sandbox: SandboxRow): Promise<void> {
    if (sandbox.provider_sandbox_id && sandbox.state === "running") {
      await this.provider.stop(sandbox.provider_sandbox_id);
    }
    await this.db.updateSandboxState(sandbox.id, "stopped");
    await this.message({
      agentId: sandbox.agent_id,
      sandboxId: sandbox.id,
      runId: sandbox.run_id,
      type: "sandbox_stopped",
      text: "Sandbox stopped",
    });
  }

  private async message(input: {
    agentId: string;
    sandboxId: string;
    runId?: string | null;
    type: string;
    text?: string | null;
  }): Promise<void> {
    const message: MessageRow = {
      agent_id: input.agentId,
      sandbox_id: input.sandboxId,
      run_id: input.runId ?? null,
      type: input.type,
      text: input.text ?? null,
    };
    await this.db.appendMessage(input);
    this.bus.publish(message);
  }

  private async sandboxRepoUrl(sandbox: SandboxRow): Promise<string> {
    const agent = await this.db.getAgent(sandbox.agent_id);
    if (!agent) throw new Error(`sandbox agent not found: ${sandbox.agent_id}`);
    return agent.repo_url;
  }

  private async sandboxRef(sandbox: SandboxRow): Promise<string> {
    if (!sandbox.run_id) {
      const agent = await this.db.getAgent(sandbox.agent_id);
      if (!agent) throw new Error(`sandbox agent not found: ${sandbox.agent_id}`);
      return agent.current_ref;
    }
    const run = await this.db.getAgentRun(sandbox.run_id);
    if (!run) throw new Error(`sandbox run not found: ${sandbox.run_id}`);
    return run.run_branch;
  }
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

const requireNonEmpty = (value: string, field: string): string => {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} must be a non-empty string`);
  return trimmed;
};

const requireCommitSha = (value: string): string => {
  const trimmed = value.trim();
  if (!/^[a-f0-9]{40}$/i.test(trimmed)) throw new Error(`invalid result commit sha: ${trimmed}`);
  return trimmed;
};

const commandInCwd = (command: string[], cwd: string): string[] => [
  "sh",
  "-lc",
  `cd ${shellQuote(cwd)} && exec "$@"`,
  "threadbeat-exec",
  ...command,
];

const createRedactor = (replacements: Record<string, string> | undefined): ((value: string) => string) => {
  const entries = Object.entries(replacements ?? {}).filter(([from]) => from.length > 0);
  if (entries.length === 0) return (value) => value;
  return (value) => entries.reduce(
    (redacted, [from, to]) => redacted.split(from).join(to),
    value,
  );
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
