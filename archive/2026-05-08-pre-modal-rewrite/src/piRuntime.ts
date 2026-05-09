import {
  AuthStorage,
  createAgentSession,
  createReadOnlyTools,
  ModelRegistry,
  SessionManager,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import path from "node:path";

import type { Settings } from "./config.js";

export type RuntimeStatus = {
  mode: "dry-run" | "pi-sdk";
  running: boolean;
  sessionId: string | null;
  resetCount: number;
  runTimeoutMs: number;
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

export type RuntimeLifecycleEvent = {
  type: "runtime_reset_started" | "runtime_reset_completed" | "runtime_reset_failed";
  heartbeatId?: string | null;
  message: string;
  data?: Record<string, unknown>;
};

export interface RuntimeManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  reset(): Promise<void>;
  run(prompt: string, heartbeatId: string): Promise<string>;
  streamMessage(
    prompt: string,
    onDelta: (delta: string) => void,
    memoryMode?: RuntimeMemoryMode,
  ): Promise<string>;
  status(): RuntimeStatus;
}

export type RuntimeMemoryMode = "shared" | "stateless";

export class PiSharedSessionRuntime implements RuntimeManager {
  private session: AgentSession | null = null;
  private resetCount = 0;
  private currentHeartbeatId: string | null = null;
  private activeRun: RuntimeRunSnapshot | null = null;
  private lastRun: RuntimeRunSnapshot | null = null;
  private lastError: string | null = null;
  private startPromise: Promise<void> | null = null;
  private readonly lock = new AsyncLock();

  constructor(
    private readonly settings: Settings,
    private readonly onLifecycleEvent?: (event: RuntimeLifecycleEvent) => Promise<void>,
  ) {}

  async start(): Promise<void> {
    if (this.settings.piDryRun) return;
    if (this.session) return;
    if (this.startPromise) return this.startPromise;
    const timeoutMs = Math.min(this.settings.runTimeoutMs, 60_000);
    this.startPromise = withTimeout(
      this.createSession(),
      timeoutMs,
      `Pi session start timed out after ${timeoutMs}ms`,
    )
      .then((session) => {
        this.session = session;
      })
      .catch((error: unknown) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      })
      .finally(() => {
        this.startPromise = null;
      });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.session?.dispose();
    this.session = null;
  }

  async reset(): Promise<void> {
    await this.emitLifecycleEvent({
      type: "runtime_reset_started",
      message: "Manual runtime reset started",
      data: { reason: "manual", resetCount: this.resetCount },
    });
    await this.stop();
    this.resetCount += 1;
    this.lastError = null;
    await this.start();
    await this.emitLifecycleEvent({
      type: "runtime_reset_completed",
      message: "Manual runtime reset completed",
      data: { reason: "manual", resetCount: this.resetCount },
    });
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
        const text = await withTimeout(
          this.executePrompt(prompt, heartbeatId),
          this.settings.runTimeoutMs,
          `heartbeat ${heartbeatId} timed out after ${this.settings.runTimeoutMs}ms`,
        );
        this.recordCompletedRun("succeeded", heartbeatId, startedAt, startedAtMs);
        return text;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.lastError = message;
        this.recordCompletedRun("failed", heartbeatId, startedAt, startedAtMs);
        await this.resetAfterFailure(message, heartbeatId);
        throw error;
      } finally {
        this.currentHeartbeatId = null;
        this.activeRun = null;
      }
    });
  }

  async streamMessage(
    prompt: string,
    onDelta: (delta: string) => void,
    memoryMode: RuntimeMemoryMode = "shared",
  ): Promise<string> {
    return this.lock.run(async () => {
      const heartbeatId = memoryMode === "stateless" ? "interactive-stateless" : "interactive";
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
        const text = await withTimeout(
          memoryMode === "stateless"
            ? this.executePromptStreamingStateless(prompt, onDelta)
            : this.executePromptStreaming(prompt, onDelta),
          this.settings.runTimeoutMs,
          `interactive message timed out after ${this.settings.runTimeoutMs}ms`,
        );
        this.recordCompletedRun("succeeded", heartbeatId, startedAt, startedAtMs);
        return text;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.lastError = message;
        this.recordCompletedRun("failed", heartbeatId, startedAt, startedAtMs);
        await this.resetAfterFailure(message, heartbeatId);
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
      runTimeoutMs: this.settings.runTimeoutMs,
      currentHeartbeatId: this.currentHeartbeatId,
      activeRun: this.activeRun,
      lastRun: this.lastRun,
      queueDepth: this.lock.queueDepth(),
      lastError: this.lastError,
      model: `${this.settings.piProvider}/${this.settings.piModel}`,
    };
  }

  private async executePrompt(prompt: string, heartbeatId: string): Promise<string> {
    if (this.settings.piDryRun) {
      if (this.settings.piDryRunDelayMs > 0) await sleep(this.settings.piDryRunDelayMs);
      return [
        "[dry-run]",
        `heartbeat_id: ${heartbeatId}`,
        "observed: prompt materialized and would be sent through Pi SDK",
        "next_action: keep scheduler running",
        "",
        prompt.slice(0, 500),
      ].join("\n");
    }

    await this.start();
    if (!this.session) throw new Error("Pi session did not start");
    await this.session.prompt(prompt);
    const text = this.session.getLastAssistantText();
    const lastError = getLastAssistantError(this.session);
    if (lastError) throw new Error(lastError);
    if (!text) throw new Error("Pi completed without assistant text");
    return text;
  }

  private async executePromptStreaming(prompt: string, onDelta: (delta: string) => void): Promise<string> {
    if (this.settings.piDryRun) {
      const text = `[dry-run]\nobserved: message would be sent through server-side Pi SDK\n\n${prompt.slice(0, 500)}`;
      onDelta(text);
      return text;
    }

    await this.start();
    if (!this.session) throw new Error("Pi session did not start");

    let streamedText = "";
    const unsubscribe = this.session.subscribe((event) => {
      if (event.type !== "message_update") return;
      if (event.assistantMessageEvent.type !== "text_delta") return;
      streamedText += event.assistantMessageEvent.delta;
      onDelta(event.assistantMessageEvent.delta);
    });
    try {
      await this.session.prompt(prompt);
    } finally {
      unsubscribe();
    }

    const lastError = getLastAssistantError(this.session);
    if (lastError) throw new Error(lastError);

    const text = this.session.getLastAssistantText() ?? streamedText.trim();
    if (!text) throw new Error("Pi completed without assistant text");
    return text;
  }

  private async executePromptStreamingStateless(prompt: string, onDelta: (delta: string) => void): Promise<string> {
    if (this.settings.piDryRun) {
      const text = `[dry-run]\nobserved: message would be sent through a stateless server-side Pi SDK session\n\n${prompt.slice(0, 500)}`;
      onDelta(text);
      return text;
    }

    const session = await this.createSession();
    let streamedText = "";
    const unsubscribe = session.subscribe((event) => {
      if (event.type !== "message_update") return;
      if (event.assistantMessageEvent.type !== "text_delta") return;
      streamedText += event.assistantMessageEvent.delta;
      onDelta(event.assistantMessageEvent.delta);
    });
    try {
      await session.prompt(prompt);
    } finally {
      unsubscribe();
      session.dispose();
    }

    const lastError = getLastAssistantError(session);
    if (lastError) throw new Error(lastError);

    const text = session.getLastAssistantText() ?? streamedText.trim();
    if (!text) throw new Error("Pi completed without assistant text");
    return text;
  }

  private async createSession(): Promise<AgentSession> {
    const authStorage = AuthStorage.create();
    if (this.settings.deepseekApiKey) {
      authStorage.setRuntimeApiKey(this.settings.piProvider, this.settings.deepseekApiKey);
    }
    const modelRegistry = new ModelRegistry(authStorage, path.join(this.settings.projectRoot, "pi-models.json"));
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
    return session;
  }

  private async resetAfterFailure(originalError: string, heartbeatId: string): Promise<void> {
    await this.emitLifecycleEvent({
      type: "runtime_reset_started",
      heartbeatId,
      message: "Automatic runtime reset started after failure",
      data: { reason: "automatic", error: originalError, resetCount: this.resetCount },
    });
    try {
      await this.stop();
      this.resetCount += 1;
      await this.start();
      this.lastError = originalError;
      await this.emitLifecycleEvent({
        type: "runtime_reset_completed",
        heartbeatId,
        message: "Automatic runtime reset completed after failure",
        data: { reason: "automatic", error: originalError, resetCount: this.resetCount },
      });
    } catch (error) {
      const resetError = error instanceof Error ? error.message : String(error);
      this.lastError = `${originalError}; automatic reset failed: ${resetError}`;
      await this.emitLifecycleEvent({
        type: "runtime_reset_failed",
        heartbeatId,
        message: "Automatic runtime reset failed",
        data: {
          reason: "automatic",
          error: originalError,
          resetError,
          resetCount: this.resetCount,
        },
      });
    }
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

  private async emitLifecycleEvent(event: RuntimeLifecycleEvent): Promise<void> {
    await this.onLifecycleEvent?.(event);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const getLastAssistantError = (session: AgentSession): string | undefined => {
  const assistant = session.messages
    .slice()
    .reverse()
    .find((message) => message.role === "assistant") as { errorMessage?: string } | undefined;
  return assistant?.errorMessage;
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

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
