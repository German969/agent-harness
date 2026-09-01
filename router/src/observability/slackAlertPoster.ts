// Real SlackAlertPoster — posts one-shot messages to a Slack channel.
//
// This complements `MemoryAlertPoster` / `NoopAlertPoster` from alerts.ts.
// Not a streaming client (unlike Phase 7's SlackReplyClient) — alerts are
// one-and-done, no message editing. Native fetch, no @slack/web-api.

import type { FetchLike } from '../reply/types.js';
import type { AlertMessage, AlertPoster } from './alerts.js';

const SLACK_POST = 'https://slack.com/api/chat.postMessage';

export type SlackAlertPosterOptions = {
  /** Slack bot token (xoxb-...). */
  token: string;
  /** Optional fetch injection for tests. */
  fetch?: FetchLike | undefined;
  /** Emit alerts that don't match `channel` here as a fallback. Optional. */
  defaultChannel?: string | undefined;
  /** Called on post error (post is fire-and-forget). */
  onError?: ((err: Error) => void) | undefined;
};

export class SlackAlertPoster implements AlertPoster {
  readonly kind = 'slack' as const;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly opts: SlackAlertPosterOptions) {
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  async post(msg: AlertMessage): Promise<void> {
    const channel = msg.channel || this.opts.defaultChannel;
    if (!channel) {
      this.opts.onError?.(new Error(`slack alert has no channel + no default: ${msg.title}`));
      return;
    }

    const text = renderAlertText(msg);

    try {
      const res = await this.fetchImpl(SLACK_POST, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.opts.token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ channel, text }),
      });
      if (!res.ok) {
        this.opts.onError?.(new Error(`slack alert HTTP ${res.status}`));
        return;
      }
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) {
        this.opts.onError?.(new Error(`slack alert error: ${json.error ?? 'unknown'}`));
      }
    } catch (err) {
      this.opts.onError?.(err as Error);
    }
  }
}

/** Compose a plain-text alert body from title + body + fields. */
export function renderAlertText(msg: AlertMessage): string {
  const lines: string[] = [`*${msg.title}*`, msg.body];
  if (msg.fields) {
    lines.push('');
    for (const [k, v] of Object.entries(msg.fields)) {
      lines.push(`• *${k}*: ${v}`);
    }
  }
  return lines.join('\n');
}
