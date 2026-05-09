import { nowIso } from "./time.js";

export type RuntimeMessageEvent =
  | {
      type: "listener_connected";
      connectedAt: string;
    }
  | {
      type: "message_started";
      messageId: string;
      input: string;
      startedAt: string;
      source?: "interactive" | "heartbeat";
      heartbeatId?: string;
      title?: string;
    }
  | {
      type: "message_delta";
      messageId: string;
      text: string;
      source?: "interactive" | "heartbeat";
      heartbeatId?: string;
    }
  | {
      type: "message_done";
      messageId: string;
      text: string;
      completedAt: string;
      source?: "interactive" | "heartbeat";
      heartbeatId?: string;
    }
  | {
      type: "message_error";
      messageId: string;
      error: string;
      completedAt: string;
      source?: "interactive" | "heartbeat";
      heartbeatId?: string;
    };

export class RuntimeMessageBus {
  private readonly subscribers = new Set<(event: RuntimeMessageEvent) => void>();

  subscribe(listener: (event: RuntimeMessageEvent) => void): () => void {
    this.subscribers.add(listener);
    listener({
      type: "listener_connected",
      connectedAt: nowIso(),
    });
    return () => {
      this.subscribers.delete(listener);
    };
  }

  publish(event: RuntimeMessageEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  size(): number {
    return this.subscribers.size;
  }
}
