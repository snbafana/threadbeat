import type { ContentsLoader } from "./contents.js";
import type { Database } from "./db.js";
import type { RuntimeMessageEvent } from "./messageBus.js";
import type { RuntimeManager } from "./piRuntime.js";
import { nowIso } from "./time.js";
import type { HeartbeatRow, HeartbeatRunRow } from "./types.js";

export class HeartbeatExecutor {
  constructor(
    private readonly db: Database,
    private readonly contents: ContentsLoader,
    private readonly runtime: RuntimeManager,
    private readonly publishRuntimeMessage?: (event: RuntimeMessageEvent) => void,
  ) {}

  async execute(
    heartbeat: HeartbeatRow,
    options: { reschedule?: boolean } = {},
  ): Promise<HeartbeatRunRow> {
    let promptSnapshot = "";
    const reschedule = options.reschedule ?? true;
    const messageId = heartbeatMessageId(heartbeat.id);
    this.publishHeartbeatStarted(heartbeat, messageId);
    await this.db.createEvent({
      heartbeatId: heartbeat.id,
      sessionId: heartbeat.session_id,
      source: "executor",
      type: "run_started",
      message: "Heartbeat execution started",
    });
    try {
      const markdown = await this.contents.readMarkdown(heartbeat.contents);
      await this.db.createEvent({
        heartbeatId: heartbeat.id,
        sessionId: heartbeat.session_id,
        source: "executor",
        type: "contents_loaded",
        message: "Markdown contents loaded",
        data: { contents: heartbeat.contents },
      });
      promptSnapshot = buildPrompt(heartbeat, markdown);
      const output = await this.runtime.run(promptSnapshot, heartbeat.id);
      this.publishHeartbeatSucceeded(heartbeat, messageId, output);
      return await this.finish(heartbeat, {
        status: "succeeded",
        promptSnapshot,
        output,
        error: null,
        reschedule,
      });
    } catch (error) {
      if (!promptSnapshot) promptSnapshot = buildPrompt(heartbeat, "");
      this.publishHeartbeatFailed(heartbeat, messageId, error);
      return this.finish(heartbeat, {
        status: "failed",
        promptSnapshot,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        reschedule,
      });
    }
  }

  private async finish(
    heartbeat: HeartbeatRow,
    result: {
      status: "succeeded" | "failed";
      promptSnapshot: string;
      output: string | null;
      error: string | null;
      reschedule: boolean;
    },
  ): Promise<HeartbeatRunRow> {
    const run = await this.db.createRun({
      heartbeatId: heartbeat.id,
      sessionId: heartbeat.session_id,
      executor: "pi-shared-session",
      model: `${heartbeat.provider}/${heartbeat.model}`,
      status: result.status,
      promptSnapshot: result.promptSnapshot,
      output: result.output,
      error: result.error,
    });
    if (result.reschedule) await this.db.tickHeartbeat(heartbeat.id);
    await this.db.createEvent({
      heartbeatId: heartbeat.id,
      runId: run.id,
      sessionId: heartbeat.session_id,
      source: "executor",
      type: result.status === "succeeded" ? "run_succeeded" : "run_failed",
      message:
        result.status === "succeeded"
          ? "Heartbeat execution succeeded"
          : "Heartbeat execution failed",
      data: { error: result.error },
    });
    await this.db.createEvent({
      heartbeatId: heartbeat.id,
      runId: run.id,
      sessionId: heartbeat.session_id,
      source: "executor",
      type: result.reschedule ? "heartbeat_rescheduled" : "heartbeat_schedule_preserved",
      message: result.reschedule
        ? "Heartbeat tick advanced after run"
        : "Manual run completed without changing heartbeat schedule",
    });
    return run;
  }

  private publishHeartbeatStarted(heartbeat: HeartbeatRow, messageId: string): void {
    this.publishRuntimeMessage?.({
      type: "message_started",
      messageId,
      input: `heartbeat: ${heartbeat.title} (${heartbeat.id})`,
      startedAt: nowIso(),
      source: "heartbeat",
      heartbeatId: heartbeat.id,
      title: heartbeat.title,
    });
  }

  private publishHeartbeatSucceeded(
    heartbeat: HeartbeatRow,
    messageId: string,
    output: string,
  ): void {
    this.publishRuntimeMessage?.({
      type: "message_delta",
      messageId,
      text: output,
      source: "heartbeat",
      heartbeatId: heartbeat.id,
    });
    this.publishRuntimeMessage?.({
      type: "message_done",
      messageId,
      text: output,
      completedAt: nowIso(),
      source: "heartbeat",
      heartbeatId: heartbeat.id,
    });
  }

  private publishHeartbeatFailed(
    heartbeat: HeartbeatRow,
    messageId: string,
    error: unknown,
  ): void {
    this.publishRuntimeMessage?.({
      type: "message_error",
      messageId,
      error: error instanceof Error ? error.message : String(error),
      completedAt: nowIso(),
      source: "heartbeat",
      heartbeatId: heartbeat.id,
    });
  }
}

export const buildPrompt = (heartbeat: HeartbeatRow, markdown: string): string =>
  [
    "# Threadbeat heartbeat",
    "",
    `heartbeat_id: ${heartbeat.id}`,
    `session_id: ${heartbeat.session_id}`,
    `title: ${heartbeat.title}`,
    `cadence_seconds: ${heartbeat.cadence}`,
    `contents_path: ${heartbeat.contents}`,
    `provider: ${heartbeat.provider}`,
    `model: ${heartbeat.model}`,
    `last_tick: ${heartbeat.last_tick ?? "null"}`,
    `next_tick: ${heartbeat.next_tick ?? "null"}`,
    `now: ${nowIso()}`,
    "",
    "Read the markdown contents below and execute this heartbeat.",
    "Return a concise note with:",
    "1. what you observed",
    "2. the next action",
    "3. any state update worth carrying forward",
    "",
    "## Markdown contents",
    "",
    markdown,
  ].join("\n");

const heartbeatMessageId = (heartbeatId: string): string =>
  `heartbeat_${heartbeatId}_${Date.now()}`;
