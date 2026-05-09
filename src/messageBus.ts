import type { MessageRow } from "./types.js";

export class MessageBus {
  private readonly subscribers = new Set<(message: MessageRow) => void>();

  publish(message: MessageRow): void {
    for (const subscriber of this.subscribers) subscriber(message);
  }

  subscribe(subscriber: (message: MessageRow) => void): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }
}
