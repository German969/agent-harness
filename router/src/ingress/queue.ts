// In-memory event queue.
//
// Per router/ARCHITECTURE.md §1.1 — a single in-memory channel; no Redis. The
// HTTP route returns 202 immediately after enqueue; consumers (the classifier
// + runtime, wired in Phase 4 + Phase 6) drain the queue asynchronously.
//
// On process restart, in-flight events are recovered from the dedup table
// (webhook_deliveries) + per-provider webhook replay APIs. For Phase 3 the
// queue is fire-and-forget; the classifier plumbing lands in later phases.

import type { WebhookEvent } from './types.js';

export type EventConsumer = (event: WebhookEvent) => Promise<void>;

export class EventQueue {
  private readonly buffer: WebhookEvent[] = [];
  private consumer?: EventConsumer;
  private draining = false;

  /** Attach a consumer. Only one consumer per queue in v1. */
  onEvent(consumer: EventConsumer): void {
    this.consumer = consumer;
    // Kick the drain in case events accumulated before the consumer arrived.
    void this.drain();
  }

  /** Enqueue an event. Non-blocking; consumer runs on the next tick. */
  enqueue(event: WebhookEvent): void {
    this.buffer.push(event);
    void this.drain();
  }

  /** Current backlog size. Used by /ready. */
  size(): number {
    return this.buffer.length;
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.consumer) return;
    this.draining = true;
    try {
      while (this.buffer.length > 0) {
        const event = this.buffer.shift();
        if (!event) break;
        try {
          await this.consumer(event);
        } catch (err) {
          // Consumer errors are logged by the consumer itself; queue keeps
          // draining. Losing an event here is preferable to a stuck queue.
          console.error('event consumer error', err);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
