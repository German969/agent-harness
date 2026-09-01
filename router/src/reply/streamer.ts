// Reply streamer — the runtime-facing surface.
//
// Given a ReplyTarget, this builds the appropriate per-provider client and
// exposes push()/finalize() that the runtime calls from SDK.onPartial +
// session completion.
//
// The runtime doesn't care WHICH provider — it just calls streamer.push(text)
// on each chunk + streamer.finalize(text + footer) at the end.

import type { Logger } from 'pino';
import { renderFooter, renderOutcomeNotice } from './footer.js';
import { GitHubReplyClient } from './github.js';
import { LinearReplyClient } from './linear.js';
import { SlackReplyClient } from './slack.js';
import type { FetchLike, ReplyClient, ReplyTarget, SessionFooter } from './types.js';

export type StreamerOptions = {
  target: ReplyTarget;
  /** Injected fetch — tests use this; production uses global fetch. */
  fetch?: FetchLike | undefined;
  log?: Logger | undefined;
};

/**
 * Build the right per-provider client based on target.provider.
 */
export function buildReplyClient(opts: StreamerOptions): ReplyClient {
  const onError = opts.log
    ? (err: Error): void => {
        opts.log?.warn({ err: err.message }, 'reply send failed');
      }
    : undefined;

  switch (opts.target.provider) {
    case 'slack':
      return new SlackReplyClient({
        target: opts.target,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(onError ? { onError } : {}),
      });
    case 'linear':
      return new LinearReplyClient({
        target: opts.target,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(onError ? { onError } : {}),
      });
    case 'github':
      return new GitHubReplyClient({
        target: opts.target,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(onError ? { onError } : {}),
      });
  }
}

/**
 * A running per-session streamer. Accumulates chunks; sends periodically;
 * appends the footer + flushes at session end.
 */
export class ReplyStreamer {
  private accumulated = '';
  private readonly client: ReplyClient;

  constructor(opts: StreamerOptions) {
    this.client = buildReplyClient(opts);
  }

  /** Called from SDK.onPartial. Appends chunk to the running message. */
  push(chunk: string): void {
    this.accumulated += chunk;
    // A turn can end with no visible text — a thinking-only assistant turn adds
    // nothing here — leaving `accumulated` blank. Sending that is pointless on
    // every provider and an outright error on GitHub, which rejects a blank
    // comment body with HTTP 422 ("Body cannot be blank"). Wait for real text.
    const body = this.body();
    if (body === '') return;
    // Fire-and-forget: batcher already handles rate limiting + errors.
    void this.client.send(body);
  }

  /**
   * The accumulated text as it should be posted. Trimmed because thinking-only
   * turns contribute newlines and nothing else: a session that thinks for a
   * while before speaking otherwise opens its reply with a wall of blank lines
   * (observed on IRS-46 — ~100 of them above the first sentence).
   */
  private body(): string {
    return this.accumulated.trim();
  }

  /**
   * Finalize: append the session footer to the current message + flush now.
   * Called after the SDK returns a terminal outcome.
   */
  async finalize(footer: SessionFooter): Promise<void> {
    // Notice first, then the footer. On a truncated session the body may be
    // empty — the notice still posts, so the ticket says why nothing came back
    // instead of staying silent.
    const finalText = this.body() + renderOutcomeNotice(footer.outcome) + renderFooter(footer);
    await this.client.finalize(finalText);
  }
}
