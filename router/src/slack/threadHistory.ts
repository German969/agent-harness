// Slack thread-history fetcher — used by the consumer to inject prior
// conversation history as initialContext when a webhook arrives on an existing
// thread. This is the router-side implementation of "thread continuity"
// (Anthropic's server-side `resume` is not reliable — session state expires
// too quickly to depend on it, so we reconstruct context ourselves).
//
// Direct fetch keeps deps minimal; we already use the same pattern in
// reply/slack.ts for chat.postMessage / chat.update.

import type { Logger } from 'pino';
import type { FetchLike } from '../reply/types.js';

const SLACK_CONVERSATIONS_REPLIES = 'https://slack.com/api/conversations.replies';

export type SlackThreadMessage = {
  ts: string;
  user?: string;
  bot_id?: string;
  text: string;
  subtype?: string;
};

export type FetchOptions = {
  botToken: string;
  channel: string;
  thread_ts: string;
  fetch?: FetchLike | undefined;
  log?: Logger | undefined;
  /** Cap the number of messages returned. Slack allows up to 1000; we cap at
   *  100 by default to keep context budget under control. */
  limit?: number | undefined;
};

/**
 * Fetch messages in a Slack thread via conversations.replies. Returns the
 * messages ordered oldest → newest. Throws on network error or Slack `ok: false`.
 */
export async function fetchSlackThread(opts: FetchOptions): Promise<SlackThreadMessage[]> {
  const fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
  const limit = opts.limit ?? 100;
  const url = `${SLACK_CONVERSATIONS_REPLIES}?channel=${encodeURIComponent(opts.channel)}&ts=${encodeURIComponent(opts.thread_ts)}&limit=${limit}`;
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${opts.botToken}` },
  });
  if (!res.ok) {
    throw new Error(`slack conversations.replies → HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    ok: boolean;
    messages?: SlackThreadMessage[];
    error?: string;
  };
  if (!json.ok) {
    throw new Error(`slack conversations.replies → ${json.error ?? 'unknown_error'}`);
  }
  return json.messages ?? [];
}

/**
 * Format a Slack thread as human-readable prior conversation for the model.
 * Excludes the message matching `currentTs` so the triggering mention isn't
 * duplicated (it's already the SDK's initialMessage).
 *
 * Each message becomes one paragraph:
 *   [ISO timestamp] <@USER>: text
 * or, for bot messages:
 *   [ISO timestamp] @bot(<bot_id>): text
 *
 * Slack user IDs aren't resolved to display names here — that's followup #6.
 * The tokens are still meaningful to the model as stable identifiers.
 */
export function formatThreadAsContext(
  messages: SlackThreadMessage[],
  opts: { currentTs?: string | undefined } = {},
): string {
  const filtered = opts.currentTs ? messages.filter((m) => m.ts !== opts.currentTs) : messages;
  if (filtered.length === 0) return '';
  return filtered
    .map((m) => {
      const author = m.bot_id ? `@bot(${m.bot_id})` : m.user ? `<@${m.user}>` : `<unknown:${m.ts}>`;
      const iso = new Date(Number.parseFloat(m.ts) * 1000).toISOString();
      return `[${iso}] ${author}: ${m.text}`;
    })
    .join('\n\n');
}
