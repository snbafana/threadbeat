import type { ContentsLoader } from "./contents.js";
import type { Database } from "./db.js";
import type { RuntimeManager } from "./piRuntime.js";
import { nowIso } from "./time.js";
import type { HeartbeatRow, HeartbeatRunRow } from "./types.js";

export class HeartbeatExecutor {
  constructor(
    private readonly db: Database,
    private readonly contents: ContentsLoader,
    private readonly runtime: RuntimeManager,
    private readonly model: string,
  ) {}

  async execute(heartbeat: HeartbeatRow): Promise<HeartbeatRunRow> {
    let promptSnapshot = "";
    try {
      const markdown = await this.contents.readMarkdown(heartbeat.contents);
      promptSnapshot = buildPrompt(heartbeat, markdown);
      const output = await this.runtime.run(promptSnapshot, heartbeat.id);
      return await this.finish(heartbeat, {
        status: "succeeded",
        promptSnapshot,
        output,
        error: null,
      });
    } catch (error) {
      if (!promptSnapshot) promptSnapshot = buildPrompt(heartbeat, "");
      return this.finish(heartbeat, {
        status: "failed",
        promptSnapshot,
        output: null,
        error: error instanceof Error ? error.message : String(error),
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
    },
  ): Promise<HeartbeatRunRow> {
    const run = await this.db.createRun({
      heartbeatId: heartbeat.id,
      sessionId: heartbeat.session_id,
      executor: "pi-shared-session",
      model: this.model,
      status: result.status,
      promptSnapshot: result.promptSnapshot,
      output: result.output,
      error: result.error,
    });
    await this.db.tickHeartbeat(heartbeat.id);
    return run;
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
