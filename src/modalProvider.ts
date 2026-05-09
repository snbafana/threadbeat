import type { Settings } from "./config.js";

export type SandboxStartInput = {
  sandboxName: string;
};

export type SandboxExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type SandboxExecInput = {
  timeoutMs?: number;
};

export interface SandboxProvider {
  start(input: SandboxStartInput): Promise<{ providerSandboxId: string }>;
  exec(providerSandboxId: string, command: string[], input?: SandboxExecInput): Promise<SandboxExecResult>;
  stop(providerSandboxId: string): Promise<void>;
}

export const createSandboxProvider = (settings: Settings): SandboxProvider => {
  if (settings.modalMode === "live") return new ModalSandboxProvider(settings);
  return new DryRunSandboxProvider();
};

class DryRunSandboxProvider implements SandboxProvider {
  async start(input: SandboxStartInput): Promise<{ providerSandboxId: string }> {
    return { providerSandboxId: `dry_${input.sandboxName}_${Date.now()}` };
  }

  async exec(_providerSandboxId: string, command: string[], _input: SandboxExecInput = {}): Promise<SandboxExecResult> {
    if (command.join(" ").includes("git rev-parse HEAD")) {
      return {
        stdout: "0123456789abcdef0123456789abcdef01234567\n",
        stderr: "",
        exitCode: 0,
      };
    }
    return {
      stdout: `[dry-run] ${command.join(" ")}\n`,
      stderr: "",
      exitCode: 0,
    };
  }

  async stop(_providerSandboxId: string): Promise<void> {
    return undefined;
  }
}

class ModalSandboxProvider implements SandboxProvider {
  constructor(private readonly settings: Settings) {}

  async start(input: SandboxStartInput): Promise<{ providerSandboxId: string }> {
    assertModalAuth();
    const { modal, app, image } = await this.modalResources();
    const sandbox = await modal.sandboxes.create(app, image, {
      command: ["sleep", "86400"],
      env: this.settings.sandboxEnv,
      name: input.sandboxName,
    });
    return { providerSandboxId: sandbox.sandboxId as string };
  }

  async exec(providerSandboxId: string, command: string[], input: SandboxExecInput = {}): Promise<SandboxExecResult> {
    const { modal } = await this.modalResources();
    const sandbox = await modal.sandboxes.fromId(providerSandboxId);
    const process = await sandbox.exec(command, {
      stdout: "pipe",
      stderr: "pipe",
      timeoutMs: input.timeoutMs,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      process.stdout.readText(),
      process.stderr.readText(),
      process.wait(),
    ]);
    return { stdout, stderr, exitCode };
  }

  async stop(providerSandboxId: string): Promise<void> {
    const { modal } = await this.modalResources();
    const sandbox = await modal.sandboxes.fromId(providerSandboxId);
    await sandbox.terminate();
  }

  private async modalResources(): Promise<{ modal: any; app: any; image: any }> {
    const { ModalClient } = await import("modal");
    const modal = new ModalClient();
    const app = await modal.apps.fromName(this.settings.modalAppName, { createIfMissing: true });
    const baseImage = modal.images.fromRegistry(this.settings.modalImage);
    const imageCommands = this.settings.modalImageCommands ?? [];
    const image = imageCommands.length > 0
      ? baseImage.dockerfileCommands(imageCommands)
      : baseImage;
    return { modal, app, image };
  }
}

const assertModalAuth = (): void => {
  if (!process.env.MODAL_TOKEN_ID || !process.env.MODAL_TOKEN_SECRET) {
    throw new Error("MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are required for live Modal mode");
  }
};
