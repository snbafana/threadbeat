import type { Database } from "./db.js";
import type { HeartbeatExecutor } from "./executor.js";

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastError: string | null = null;

  constructor(
    private readonly db: Database,
    private readonly executor: HeartbeatExecutor,
    private readonly pollSeconds: number,
    private readonly maxDuePerPoll: number,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => {
        this.lastError = messageOf(error);
      });
    }, this.pollSeconds * 1000);
    void this.runOnce().catch((error: unknown) => {
      this.lastError = messageOf(error);
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const due = await this.db.listDueHeartbeats(this.maxDuePerPoll);
      this.lastError = null;
      if (due.length > 0) {
        await this.db.createEvent({
          source: "scheduler",
          type: "poll_completed",
          message: `Scheduler found ${due.length} due heartbeat(s)`,
          data: { count: due.length, maxDuePerPoll: this.maxDuePerPoll },
        });
      }
      for (const heartbeat of due) {
        await this.db.createEvent({
          heartbeatId: heartbeat.id,
          sessionId: heartbeat.session_id,
          source: "scheduler",
          type: "heartbeat_claimed",
          message: "Scheduler claimed due heartbeat",
        });
        await this.executor.execute(heartbeat);
      }
      return due.length;
    } catch (error) {
      const message = messageOf(error);
      this.lastError = message;
      await this.recordPollFailure(message);
      throw error;
    } finally {
      this.running = false;
    }
  }

  status(): { loopActive: boolean; pollRunning: boolean; lastError: string | null } {
    return {
      loopActive: this.timer !== null,
      pollRunning: this.running,
      lastError: this.lastError,
    };
  }

  private async recordPollFailure(message: string): Promise<void> {
    try {
      await this.db.createEvent({
        source: "scheduler",
        type: "poll_failed",
        message,
        data: { maxDuePerPoll: this.maxDuePerPoll },
      });
    } catch {
      // If the event log itself is unavailable, keep the process alive and
      // expose the failure through scheduler.status().
    }
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
