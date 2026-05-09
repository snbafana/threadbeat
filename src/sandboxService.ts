import type { Database } from "./db.js";
import {
  bootstrapSandbox,
  type SandboxBootstrapCommandResult,
  type SandboxBootstrapInput,
} from "./sandboxBootstrap.js";
import type { SandboxExecResult, SandboxProvider } from "./modalProvider.js";
import type { MessageBus } from "./messageBus.js";
import type { AgentRow, MessageRow, SandboxRow } from "./types.js";

type SandboxStartOptions = {
  branch?: string;
  runId?: string | null;
};

type SandboxExecOptions = {
  redact?: Record<string, string>;
};

type SandboxBootstrapOptions = {
  baseRef?: string;
  repoUrl?: string;
  repoUrlRedacted?: string;
};

export class SandboxService {
  constructor(
    private readonly db: Database,
    private readonly provider: SandboxProvider,
    private readonly bus: MessageBus,
  ) {}

  async startForAgent(agent: AgentRow, options: SandboxStartOptions = {}): Promise<SandboxRow> {
    const branch = options.branch ?? agent.current_ref;
    let sandbox = await this.db.createSandbox({
      agentId: agent.id,
      runId: options.runId,
      repoUrl: agent.repo_url,
      branch,
    });
    await this.message({
      agentId: agent.id,
      sandboxId: sandbox.id,
      runId: options.runId,
      source: "server",
      type: "sandbox_starting",
      text: `Starting sandbox for ${agent.name}`,
      data: { repoUrl: agent.repo_url, branch, runId: options.runId ?? null },
    });

    try {
      const started = await this.provider.start({ sandboxName: sandbox.id });
      sandbox = await this.db.updateSandboxStarted(sandbox.id, started.providerSandboxId);
      await this.message({
        agentId: agent.id,
        sandboxId: sandbox.id,
        runId: options.runId,
        source: "modal",
        type: "sandbox_running",
        text: `Sandbox running: ${started.providerSandboxId}`,
        data: started,
      });
      return sandbox;
    } catch (error) {
      await this.db.updateSandboxState(sandbox.id, "failed");
      await this.message({
        agentId: agent.id,
        sandboxId: sandbox.id,
        runId: options.runId,
        source: "modal",
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
  ): Promise<{ sandbox: SandboxRow; result: SandboxExecResult }> {
    if (!sandbox.provider_sandbox_id) throw new Error("sandbox has no provider id");
    if (sandbox.state !== "running") throw new Error(`sandbox is not running: ${sandbox.state}`);
    const redact = createRedactor(options.redact);

    await this.message({
      agentId: sandbox.agent_id,
      sandboxId: sandbox.id,
      runId: sandbox.run_id,
      source: "server",
      type: "exec_started",
      text: redact(command.join(" ")),
      data: { command: command.map(redact) },
    });
    const result = await this.provider.exec(sandbox.provider_sandbox_id, command);
    const redactedResult = {
      exitCode: result.exitCode,
      stderr: redact(result.stderr),
      stdout: redact(result.stdout),
    };
    await this.message({
      agentId: sandbox.agent_id,
      sandboxId: sandbox.id,
      runId: sandbox.run_id,
      source: "sandbox",
      type: "exec_completed",
      text: redactedResult.stdout || redactedResult.stderr || `exit ${result.exitCode}`,
      data: redactedResult,
    });
    return { sandbox, result };
  }

  async bootstrap(
    sandbox: SandboxRow,
    options: SandboxBootstrapOptions = {},
  ): Promise<{ sandbox: SandboxRow; results: SandboxBootstrapCommandResult[] }> {
    const repoUrl = options.repoUrl ?? sandbox.repo_url;
    const repoUrlRedacted = options.repoUrlRedacted ?? repoUrl;
    const redactMap = repoUrl === repoUrlRedacted ? undefined : { [repoUrl]: repoUrlRedacted };
    const redact = createRedactor(redactMap);
    const input: SandboxBootstrapInput = {
      baseRef: options.baseRef,
      repoUrl,
      ref: sandbox.branch,
      workdir: sandbox.workdir,
    };
    const redactedInput = { ...input, repoUrl: repoUrlRedacted };
    await this.message({
      agentId: sandbox.agent_id,
      sandboxId: sandbox.id,
      runId: sandbox.run_id,
      source: "server",
      type: "bootstrap_started",
      text: `Bootstrapping sandbox workdir ${sandbox.workdir}`,
      data: redactedInput,
    });

    try {
      const results = await bootstrapSandbox(input, async (command) => {
        const { result } = await this.exec(sandbox, command, { redact: redactMap });
        return result;
      });
      const redactedResults = results.map((result) => ({
        ...result,
        command: result.command.map(redact),
        stderr: redact(result.stderr),
        stdout: redact(result.stdout),
      }));
      await this.message({
        agentId: sandbox.agent_id,
        sandboxId: sandbox.id,
        runId: sandbox.run_id,
        source: "sandbox",
        type: "bootstrap_completed",
        text: `Sandbox bootstrap completed in ${sandbox.workdir}`,
        data: { ...redactedInput, results: redactedResults },
      });
      return { sandbox, results };
    } catch (error) {
      await this.message({
        agentId: sandbox.agent_id,
        sandboxId: sandbox.id,
        runId: sandbox.run_id,
        source: "sandbox",
        type: "bootstrap_failed",
        text: messageOf(error),
        data: redactedInput,
      });
      throw error;
    }
  }

  async stop(sandbox: SandboxRow): Promise<SandboxRow> {
    if (sandbox.provider_sandbox_id && sandbox.state === "running") {
      await this.provider.stop(sandbox.provider_sandbox_id);
    }
    const stopped = await this.db.updateSandboxState(sandbox.id, "stopped");
    await this.message({
      agentId: sandbox.agent_id,
      sandboxId: sandbox.id,
      runId: sandbox.run_id,
      source: "server",
      type: "sandbox_stopped",
      text: `Sandbox stopped: ${sandbox.id}`,
    });
    return stopped;
  }

  private async message(input: {
    agentId: string;
    sandboxId: string;
    runId?: string | null;
    source: string;
    type: string;
    text?: string | null;
    data?: unknown;
  }): Promise<MessageRow> {
    const message = await this.db.appendMessage(input);
    this.bus.publish(message);
    return message;
  }
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

const createRedactor = (replacements: Record<string, string> | undefined): ((value: string) => string) => {
  const entries = Object.entries(replacements ?? {}).filter(([from]) => from.length > 0);
  if (entries.length === 0) return (value) => value;
  return (value) => entries.reduce(
    (redacted, [from, to]) => redacted.split(from).join(to),
    value,
  );
};
