import type { Database } from "./db.js";
import type { HeartbeatExecutor } from "./executor.js";

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: Database,
    private readonly executor: HeartbeatExecutor,
    private readonly pollSeconds: number,
    private readonly maxDuePerPoll: number,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.pollSeconds * 1000);
    void this.runOnce();
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
      for (const heartbeat of due) {
        await this.executor.execute(heartbeat);
      }
      return due.length;
    } finally {
      this.running = false;
    }
  }
}
