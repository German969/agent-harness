// Per-target rate-limit-aware debouncer.
//
// Model: the caller (reply streamer) already tracks the full cumulative text
// and calls `push(text)` with the LATEST state on every SDK partial. Providers
// rate-limit edits (Slack: 1/sec/channel; Linear: ~5/sec; GitHub: ~5000/hr).
// The batcher holds the latest text; on each call:
//   - If we're allowed to flush now, do it with the current text.
//   - Otherwise, replace the pending text and let the timer fire it.
//
// `push(text)` REPLACES the pending buffer — not append. The caller is the
// single source of truth for cumulative state; the batcher is a debouncer.
//
// `finalize(text)` bypasses the rate limit + flushes immediately with the
// final text (usually last-chunk + footer). This is called at session end.

export type BatcherOptions = {
  /** Minimum ms between flushes. Slack=1000, Linear=200, GitHub=500. */
  intervalMs: number;
  /** The function that actually sends. Called with the full accumulated text. */
  flush: (text: string) => Promise<void>;
  /** Called on flush error — batcher continues (next chunk retries). */
  onError?: (err: Error) => void;
};

export class ReplyBatcher {
  private buffer = '';
  private timer: NodeJS.Timeout | undefined;
  private lastFlushAt = 0;
  private inFlight: Promise<void> | undefined;
  private finalized = false;

  constructor(private readonly opts: BatcherOptions) {}

  /**
   * Set the latest cumulative text. May trigger an immediate flush, or
   * schedule a delayed one, depending on the last-flush timing.
   *
   * The caller passes the FULL current state on every call — the batcher
   * REPLACES its pending buffer rather than appending. Callers are the
   * single source of truth for cumulative content.
   */
  push(text: string): void {
    if (this.finalized) return; // no-op after finalize; the caller is done.
    this.buffer = text;
    this.maybeFlush();
  }

  /**
   * Flush the final content (typically last chunk + footer) NOW, bypassing the
   * rate limit. Cancels any pending timer. Idempotent — later calls no-op.
   */
  async finalize(text: string): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // Wait for any in-flight flush to complete before sending the final text
    // (avoids ordering: final overtakes penultimate).
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        /* prior error already surfaced via onError */
      }
    }
    this.buffer = text;
    await this.doFlush();
  }

  private maybeFlush(): void {
    const now = Date.now();
    const since = now - this.lastFlushAt;
    if (since >= this.opts.intervalMs && !this.inFlight && !this.timer) {
      // Flush immediately.
      this.doFlush().catch(() => {
        /* error already handled inside */
      });
      return;
    }
    // Schedule a delayed flush at the next allowed time (if not already set).
    if (!this.timer) {
      const delay = Math.max(0, this.opts.intervalMs - since);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.doFlush().catch(() => {
          /* handled */
        });
      }, delay);
      this.timer.unref?.();
    }
  }

  private async doFlush(): Promise<void> {
    // Snapshot the buffer at this moment; new chunks landing during the flush
    // are picked up in the next tick.
    const snapshot = this.buffer;
    this.lastFlushAt = Date.now();
    const p = this.opts.flush(snapshot).catch((err) => {
      if (this.opts.onError) this.opts.onError(err as Error);
    });
    this.inFlight = p;
    try {
      await p;
    } finally {
      this.inFlight = undefined;
    }
    // If more chunks accumulated during the flush AND we haven't finalized,
    // schedule a follow-up flush.
    if (!this.finalized && this.buffer !== snapshot && !this.timer) {
      this.maybeFlush();
    }
  }
}
