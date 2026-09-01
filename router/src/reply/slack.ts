// Slack reply client — chat.postMessage on first send, chat.update on subsequent.
//
// Slack rate limit for edits: ~1/sec/channel (Tier 3). We batch at 1000ms.
// We do NOT pull @slack/web-api; direct fetch keeps deps minimal + gives us
// the same guarantees for the tiny surface area we need.

import { ReplyBatcher } from './batcher.js';
import { toSlackMrkdwn } from './mrkdwn.js';
import type { FetchLike, ReplyClient, ReplyTarget } from './types.js';

const SLACK_POST = 'https://slack.com/api/chat.postMessage';
const SLACK_UPDATE = 'https://slack.com/api/chat.update';

// Slack rejects a message whose `text` field exceeds its per-message limit with
// `msg_too_long`. Despite the "40 000 character" figure in Slack's docs (which is
// the ceiling for the whole payload incl. blocks), the plain-`text` field errors
// far lower: an observed 4 805-char reply was rejected. The safe practical limit
// is ~4 000, so we cap/split well under it. Anything longer is split across
// multiple messages in the same thread (finalize) or capped (streaming edits).
const SLACK_TEXT_MAX = 3_900;
const TRUNCATION_MARKER = '\n\n_… (message truncated — the full session log has the rest.)_';

// Shown while the session is still running. The reply is posted at the first turn
// boundary, when the only accumulated text is an inter-turn paragraph break ('\n\n')
// — that posts as a blank-looking message. This placeholder stands in until real
// content arrives; the terminal edit always carries the footer, so it never remains.
const WORKING_PLACEHOLDER = '_Generating response…_';

export type SlackClientOptions = {
  target: Extract<ReplyTarget, { provider: 'slack' }>;
  fetch?: FetchLike | undefined;
  onError?: ((err: Error) => void) | undefined;
};

export class SlackReplyClient implements ReplyClient {
  readonly provider = 'slack' as const;
  private ts: string | undefined; // message ts once posted; used for edits
  private readonly fetchImpl: FetchLike;
  private readonly batcher: ReplyBatcher;

  constructor(private readonly opts: SlackClientOptions) {
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.batcher = new ReplyBatcher({
      intervalMs: 1000,
      flush: (text) => this.postOrEdit(text),
      ...(opts.onError ? { onError: opts.onError } : {}),
    });
  }

  async send(text: string): Promise<void> {
    this.batcher.push(text);
  }

  async finalize(text: string): Promise<void> {
    const converted = toSlackMrkdwn(text);
    if (converted.length <= SLACK_TEXT_MAX) {
      // Fast path — fits in one message.
      await this.batcher.finalize(text);
      return;
    }
    // Long path — split at paragraph boundaries and post each chunk as its own
    // Slack message in the same thread. The FIRST chunk finalizes the existing
    // (in-flight) message via chat.update on the captured `ts`; subsequent
    // chunks post as new messages via chat.postMessage with the same thread_ts.
    const chunks = splitForSlack(converted);
    const withHeader = chunks.map((c, i) =>
      chunks.length > 1 ? `_(part ${i + 1} of ${chunks.length})_\n\n${c}` : c,
    );
    // Batcher.finalize uses postOrEdit which passes through toSlackMrkdwn again.
    // Our conversion is idempotent — a second pass is a no-op — so it's safe to
    // pre-convert here and let the batcher's postOrEdit convert-noop it.
    const firstEntry = withHeader[0];
    if (firstEntry) await this.batcher.finalize(firstEntry);
    for (let i = 1; i < withHeader.length; i++) {
      const chunk = withHeader[i];
      if (chunk) await this.postFreshMessage(chunk);
    }
  }

  private async postOrEdit(text: string): Promise<void> {
    const url = this.ts === undefined ? SLACK_POST : SLACK_UPDATE;
    const rendered = capForSlack(toSlackMrkdwn(text));
    // Substitute the working placeholder while there's no real content yet, so the
    // in-flight message reads "Generating response…" instead of showing as blank.
    const display = rendered.trim().length === 0 ? WORKING_PLACEHOLDER : rendered;
    const body: Record<string, unknown> = {
      channel: this.opts.target.channel,
      text: display,
      ...(this.opts.target.thread_ts ? { thread_ts: this.opts.target.thread_ts } : {}),
      ...(this.ts !== undefined ? { ts: this.ts } : {}),
    };
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.opts.target.token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`slack ${url} → HTTP ${res.status}`);
    }
    const json = (await res.json()) as { ok: boolean; ts?: string; error?: string };
    if (!json.ok) {
      throw new Error(`slack ${url} → ${json.error ?? 'unknown_error'}`);
    }
    // First-post response carries the ts; store it for later edits.
    if (this.ts === undefined && json.ts) {
      this.ts = json.ts;
    }
  }

  /**
   * Post a fresh chat.postMessage in the same thread — used for chunks 2+ of a
   * split long finalize. We deliberately do NOT capture the returned ts here;
   * each chunk is standalone (no further edits) and we don't want to lose the
   * primary `ts` reference on the class.
   */
  private async postFreshMessage(text: string): Promise<void> {
    const body: Record<string, unknown> = {
      channel: this.opts.target.channel,
      text: capForSlack(toSlackMrkdwn(text)),
      ...(this.opts.target.thread_ts ? { thread_ts: this.opts.target.thread_ts } : {}),
    };
    const res = await this.fetchImpl(SLACK_POST, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.opts.target.token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`slack ${SLACK_POST} → HTTP ${res.status}`);
    }
    const json = (await res.json()) as { ok: boolean; ts?: string; error?: string };
    if (!json.ok) {
      throw new Error(`slack ${SLACK_POST} → ${json.error ?? 'unknown_error'}`);
    }
  }
}

/**
 * Cap message text to Slack's practical per-message limit. Truncates from the end (the
 * beginning of the reply is usually the more coherent framing; the tail is
 * where verbose diffs / tool traces balloon). Used on the streaming path
 * (in-flight chat.update calls) where multi-message splitting isn't possible
 * because the ts is already committed. Finalize splits instead of truncates.
 */
function capForSlack(text: string): string {
  if (text.length <= SLACK_TEXT_MAX) return text;
  const room = SLACK_TEXT_MAX - TRUNCATION_MARKER.length;
  return text.slice(0, room) + TRUNCATION_MARKER;
}

/**
 * Split `text` into chunks each <= SLACK_CHUNK_MAX chars, preferring paragraph
 * (`\n\n`) boundaries, falling back to line boundaries, then a hard slice for
 * pathological single lines. Leaves room in each chunk for a small header
 * ("_(part N of M)_\n\n") added by the caller.
 */
export function splitForSlack(text: string): string[] {
  const HEADER_HEADROOM = 40;
  const budget = SLACK_TEXT_MAX - HEADER_HEADROOM;
  if (text.length <= budget) return [text];

  const chunks: string[] = [];
  let remaining = text;

  const takeSlice = (endIdx: number): void => {
    chunks.push(remaining.slice(0, endIdx).trimEnd());
    remaining = remaining.slice(endIdx).replace(/^[\s]+/, '');
  };

  while (remaining.length > budget) {
    // Prefer the last paragraph break within budget.
    let cut = remaining.lastIndexOf('\n\n', budget);
    if (cut <= 0) cut = remaining.lastIndexOf('\n', budget);
    if (cut <= 0) cut = budget; // pathological — hard split
    takeSlice(cut);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
