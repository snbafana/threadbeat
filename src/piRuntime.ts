import {
  AuthStorage,
  createAgentSession,
  createReadOnlyTools,
  ModelRegistry,
  SessionManager,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";

import type { Settings } from "./config.js";

export type RuntimeStatus = {
  mode: "dry-run" | "pi-sdk";
  running: boolean;
  sessionId: string | null;
  resetCount: number;
  currentHeartbeatId: string | null;
  activeRun: RuntimeRunSnapshot | null;
  lastRun: RuntimeRunSnapshot | null;
  queueDepth: number;
  lastError: string | null;
  model: string;
};

export type RuntimeRunSnapshot = {
  heartbeatId: string;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
};

export interface RuntimeManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  reset(): Promise<void>;
  run(prompt: string, heartbeatId: string): Promise<string>;
  status(): RuntimeStatus;
}

export class PiSharedSessionRuntime implements RuntimeManager {
  private session: AgentSession | null = null;
  private resetCount = 0;
  private currentHeartbeatId: string | null = null;
  private activeRun: RuntimeRunSnapshot | null = null;
  private lastRun: RuntimeRunSnapshot | null = null;
  private lastError: string | null = null;
  private readonly lock = new AsyncLock();

  constructor(private readonly settings: Settings) {}

  async start(): Promise<void> {
    if (this.settings.piDryRun) return;
    if (this.session) return;

    const authStorage = AuthStorage.create();
    if (this.settings.deepseekApiKey) {
      authStorage.setRuntimeApiKey(this.settings.piProvider, this.settings.deepseekApiKey);
    }
    const modelRegistry = new ModelRegistry(authStorage);
    const model = modelRegistry.find(this.settings.piProvider, this.settings.piModel);

    const { session } = await createAgentSession({
      cwd: this.settings.repoRoot,
      authStorage,
      modelRegistry,
      model,
      thinkingLevel: this.settings.piThinking,
      tools: createReadOnlyTools(this.settings.repoRoot),
      sessionManager: SessionManager.create(this.settings.repoRoot),
    });
    this.session = session;
  }

  async stop(): Promise<void> {
    this.session?.dispose();
    this.session = null;
  }

  async reset(): Promise<void> {
    await this.stop();
    this.resetCount += 1;
    this.lastError = null;
    await this.start();
  }

  async run(prompt: string, heartbeatId: string): Promise<string> {
    return this.lock.run(async () => {
      const startedAtMs = Date.now();
      const startedAt = new Date(startedAtMs).toISOString();
      this.currentHeartbeatId = heartbeatId;
      this.activeRun = {
        heartbeatId,
        status: "running",
        startedAt,
        completedAt: null,
        durationMs: null,
      };
      try {
        if (this.settings.piDryRun) {
          const output = [
            "[dry-run]",
            `heartbeat_id: ${heartbeatId}`,
            "observed: prompt materialized and would be sent through Pi SDK",
            "next_action: keep scheduler running",
            "",
            prompt.slice(0, 500),
          ].join("\n");
          this.recordCompletedRun("succeeded", heartbeatId, startedAt, startedAtMs);
          return output;
        }

        await this.start();
        if (!this.session) throw new Error("Pi session did not start");
        await this.session.prompt(prompt);
        const text = this.session.getLastAssistantText();
        if (!text) throw new Error("Pi completed without assistant text");
        this.recordCompletedRun("succeeded", heartbeatId, startedAt, startedAtMs);
        return text;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.recordCompletedRun("failed", heartbeatId, startedAt, startedAtMs);
        throw error;
      } finally {
        this.currentHeartbeatId = null;
        this.activeRun = null;
      }
    });
  }

  status(): RuntimeStatus {
    return {
      mode: this.settings.piDryRun ? "dry-run" : "pi-sdk",
      running: this.settings.piDryRun || this.session !== null,
      sessionId: this.session?.sessionId ?? null,
      resetCount: this.resetCount,
      currentHeartbeatId: this.currentHeartbeatId,
      activeRun: this.activeRun,
      lastRun: this.lastRun,
      queueDepth: this.lock.queueDepth(),
      lastError: this.lastError,
      model: `${this.settings.piProvider}/${this.settings.piModel}`,
    };
  }

  private recordCompletedRun(
    status: "succeeded" | "failed",
    heartbeatId: string,
    startedAt: string,
    startedAtMs: number,
  ): void {
    const completedAtMs = Date.now();
    this.lastRun = {
      heartbeatId,
      status,
      startedAt,
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs: completedAtMs - startedAtMs,
    };
  }
}

class AsyncLock {
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.waiting += 1;
    await previous;
    this.waiting -= 1;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  queueDepth(): number {
    return this.waiting;
  }
}
