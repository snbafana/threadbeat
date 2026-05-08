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
    }
  | {
      type: "message_delta";
      messageId: string;
      text: string;
    }
  | {
      type: "message_done";
      messageId: string;
      text: string;
      completedAt: string;
    }
  | {
      type: "message_error";
      messageId: string;
      error: string;
      completedAt: string;
    };

export class RuntimeMessageBus {
  private readonly subscribers = new Set<(event: RuntimeMessageEvent) => void>();

  subscribe(listener: (event: RuntimeMessageEvent) => void): () => void {
    this.subscribers.add(listener);
    listener({
      type: "listener_connected",
      connectedAt: new Date().toISOString(),
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
