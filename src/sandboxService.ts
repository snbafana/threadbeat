import type { Database } from "./db.js";
import {
  bootstrapSandbox,
  type SandboxBootstrapCommandResult,
  type SandboxBootstrapInput,
} from "./sandboxBootstrap.js";
import type { SandboxExecResult, SandboxProvider } from "./modalProvider.js";
import type { MessageBus } from "./messageBus.js";
import type { AgentRow, MessageRow, SandboxRow } from "./types.js";

export class SandboxService {
  constructor(
    private readonly db: Database,
    private readonly provider: SandboxProvider,
    private readonly bus: MessageBus,
  ) {}

  async startForAgent(agent: AgentRow): Promise<SandboxRow> {
    let sandbox = await this.db.createSandbox({
      agentId: agent.id,
      repoUrl: agent.repo_url,
      branch: agent.current_ref,
    });
    await this.message({
      agentId: agent.id,
      sandboxId: sandbox.id,
      source: "server",
      type: "sandbox_starting",
      text: `Starting sandbox for ${agent.name}`,
      data: { repoUrl: agent.repo_url, branch: agent.current_ref },
    });

    try {
      const started = await this.provider.start({ sandboxName: sandbox.id });
      sandbox = await this.db.updateSandboxStarted(sandbox.id, started.providerSandboxId);
      await this.message({
        agentId: agent.id,
        sandboxId: sandbox.id,
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
        source: "modal",
        type: "sandbox_failed",
        text: messageOf(error),
      });
      throw error;
    }
  }

  async exec(sandbox: SandboxRow, command: string[]): Promise<{ sandbox: SandboxRow; result: SandboxExecResult }> {
    if (!sandbox.provider_sandbox_id) throw new Error("sandbox has no provider id");
    if (sandbox.state !== "running") throw new Error(`sandbox is not running: ${sandbox.state}`);

    await this.message({
      agentId: sandbox.agent_id,
      sandboxId: sandbox.id,
      source: "server",
      type: "exec_started",
      text: command.join(" "),
      data: { command },
    });
    const result = await this.provider.exec(sandbox.provider_sandbox_id, command);
    await this.message({
      agentId: sandbox.agent_id,
      sandboxId: sandbox.id,
      source: "sandbox",
      type: "exec_completed",
      text: result.stdout || result.stderr || `exit ${result.exitCode}`,
      data: result,
    });
    return { sandbox, result };
  }

  async bootstrap(sandbox: SandboxRow): Promise<{ sandbox: SandboxRow; results: SandboxBootstrapCommandResult[] }> {
    const input: SandboxBootstrapInput = {
      repoUrl: sandbox.repo_url,
      ref: sandbox.branch,
      workdir: sandbox.workdir,
    };
    await this.message({
      agentId: sandbox.agent_id,
      sandboxId: sandbox.id,
      source: "server",
      type: "bootstrap_started",
      text: `Bootstrapping sandbox workdir ${sandbox.workdir}`,
      data: input,
    });

    try {
      const results = await bootstrapSandbox(input, async (command) => {
        const { result } = await this.exec(sandbox, command);
        return result;
      });
      await this.message({
        agentId: sandbox.agent_id,
        sandboxId: sandbox.id,
        source: "sandbox",
        type: "bootstrap_completed",
        text: `Sandbox bootstrap completed in ${sandbox.workdir}`,
        data: { ...input, results },
      });
      return { sandbox, results };
    } catch (error) {
      await this.message({
        agentId: sandbox.agent_id,
        sandboxId: sandbox.id,
        source: "sandbox",
        type: "bootstrap_failed",
        text: messageOf(error),
        data: input,
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
      source: "server",
      type: "sandbox_stopped",
      text: `Sandbox stopped: ${sandbox.id}`,
    });
    return stopped;
  }

  private async message(input: {
    agentId: string;
    sandboxId: string;
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
