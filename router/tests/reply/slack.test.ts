// Slack reply client tests — inject a mock fetch, assert the requests it makes.

import { describe, expect, it } from 'vitest';
import { SlackReplyClient, splitForSlack } from '../../src/reply/slack.js';
import type { FetchLike } from '../../src/reply/types.js';

type Call = { url: string; body: Record<string, unknown>; auth: string };

function mockFetch(responses: Array<{ ok?: boolean; ts?: string; error?: string }>): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    const auth = String((init.headers as Record<string, string>).Authorization);
    const body = JSON.parse(String(init.body));
    calls.push({ url, body, auth });
    const r = responses[i++] ?? { ok: true, ts: '123.456' };
    return new Response(JSON.stringify(r), { status: 200 });
  };
  return { fetch: fetchImpl, calls };
}

describe('SlackReplyClient', () => {
  it('first send posts a new message; subsequent sends edit it', async () => {
    const { fetch, calls } = mockFetch([{ ok: true, ts: '9999.0001' }, { ok: true }, { ok: true }]);
    const client = new SlackReplyClient({
      target: { provider: 'slack', channel: 'C123', token: 'xoxb-test' },
      fetch,
    });
    await client.send('hello');
    // Wait past the 1s interval before the second send flushes.
    await new Promise((r) => setImmediate(r));
    await client.finalize('hello world (final)');

    // First call → postMessage. Subsequent → update with ts.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain('chat.postMessage');
    expect(calls[0]?.body).toMatchObject({ channel: 'C123', text: 'hello' });
    expect(calls[0]?.body).not.toHaveProperty('ts');
    expect(calls[0]?.auth).toBe('Bearer xoxb-test');

    expect(calls[1]?.url).toContain('chat.update');
    expect(calls[1]?.body).toMatchObject({
      channel: 'C123',
      text: 'hello world (final)',
      ts: '9999.0001',
    });
  });

  it('shows a working placeholder while the first send has no real content yet', async () => {
    const { fetch, calls } = mockFetch([{ ok: true, ts: 'p-1' }, { ok: true }]);
    const client = new SlackReplyClient({
      target: { provider: 'slack', channel: 'C1', token: 'xoxb-test' },
      fetch,
    });
    // The streamer's first push is an inter-turn paragraph break — whitespace only.
    await client.send('\n\n');
    await new Promise((r) => setImmediate(r));
    await client.finalize('the real answer');

    // First post reads as a working placeholder, not a blank message…
    expect(calls[0]?.url).toContain('chat.postMessage');
    expect(calls[0]?.body.text).toBe('_Generating response…_');
    // …and the terminal edit replaces it with the real content.
    expect(calls[1]?.url).toContain('chat.update');
    expect(calls[1]?.body).toMatchObject({ text: 'the real answer', ts: 'p-1' });
  });

  it('threads replies with thread_ts when set', async () => {
    const { fetch, calls } = mockFetch([{ ok: true, ts: 't-1' }]);
    const client = new SlackReplyClient({
      target: {
        provider: 'slack',
        channel: 'C-planning',
        thread_ts: '1234.5678',
        token: 'xoxb',
      },
      fetch,
    });
    await client.finalize('in-thread');
    expect(calls[0]?.body).toMatchObject({
      channel: 'C-planning',
      thread_ts: '1234.5678',
    });
  });

  it('throws on Slack ok:false via onError callback', async () => {
    const errors: string[] = [];
    const { fetch } = mockFetch([{ ok: false, error: 'channel_not_found' }]);
    const client = new SlackReplyClient({
      target: { provider: 'slack', channel: 'C-bad', token: 'xoxb' },
      fetch,
      onError: (e) => errors.push(e.message),
    });
    await client.send('x');
    await new Promise((r) => setImmediate(r));
    expect(errors[0]).toContain('channel_not_found');
  });

  it('finalize splits long text into thread replies at paragraph boundaries', async () => {
    const paragraph = 'x'.repeat(10_000);
    const longText = [paragraph, paragraph, paragraph, paragraph, paragraph].join('\n\n');
    expect(longText.length).toBeGreaterThan(39_500);

    const { fetch, calls } = mockFetch([
      { ok: true, ts: '111.001' }, // initial post via batcher (first push)
      { ok: true, ts: '111.001' }, // finalize edit — first chunk
      { ok: true, ts: '111.002' }, // second chunk postMessage
    ]);
    const client = new SlackReplyClient({
      target: { provider: 'slack', channel: 'C-long', token: 'xoxb-t', thread_ts: '111.000' },
      fetch,
    });
    await client.send('seed');
    await new Promise((r) => setImmediate(r));
    await client.finalize(longText);

    // At least one chat.update (finalize of first chunk) + one chat.postMessage
    // (second chunk) beyond the initial post.
    const updates = calls.filter((c) => c.url.endsWith('chat.update'));
    const posts = calls.filter((c) => c.url.endsWith('chat.postMessage'));
    expect(posts.length).toBeGreaterThanOrEqual(2); // initial + at least one continuation
    expect(updates.length).toBeGreaterThanOrEqual(1); // finalize of first chunk

    // Every posted text must be under Slack's 40k limit.
    for (const call of calls) {
      const text = call.body.text as string;
      expect(text.length).toBeLessThanOrEqual(40_000);
    }
    // Continuation chunks carry a part header.
    const continuationTexts = posts.slice(1).map((p) => p.body.text as string);
    for (const t of continuationTexts) {
      expect(t).toMatch(/_\(part \d+ of \d+\)_/);
    }
  });

  it('splits a mid-size reply that is under the old 40k threshold (regression: msg_too_long at ~4.8k)', async () => {
    // ~4,800 chars: over Slack's real ~4k `text` limit, but UNDER the old 39.5k
    // constant — so the pre-fix code took the fast path and sent it whole via
    // chat.update, which Slack rejected with `msg_too_long`, dropping the reply
    // entirely (this is what produced the founding skill's "empty response").
    const para = 'y'.repeat(1_600);
    const text = [para, para, para].join('\n\n'); // ~4,804 chars
    expect(text.length).toBeGreaterThan(4_000);
    expect(text.length).toBeLessThan(39_500);

    const { fetch, calls } = mockFetch([{ ok: true, ts: '222.001' }]);
    const client = new SlackReplyClient({
      target: { provider: 'slack', channel: 'C-mid', token: 'xoxb-t', thread_ts: '222.000' },
      fetch,
    });
    await client.send('seed');
    await new Promise((r) => setImmediate(r));
    await client.finalize(text);

    // It must fan out into the initial message + at least two split messages...
    expect(calls.length).toBeGreaterThanOrEqual(3);
    // ...and NO single posted message may exceed Slack's ~4k text limit.
    for (const call of calls) {
      expect((call.body.text as string).length).toBeLessThanOrEqual(4_000);
    }
  });
});

describe('splitForSlack', () => {
  it('returns the text unchanged when under the limit', () => {
    expect(splitForSlack('short')).toEqual(['short']);
  });

  it('splits at paragraph boundaries for long text', () => {
    const p = 'x'.repeat(20_000);
    const text = [p, p, p].join('\n\n');
    const chunks = splitForSlack(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(39_500);
  });

  it('falls back to hard split when a single line exceeds the budget', () => {
    const monster = 'x'.repeat(50_000);
    const chunks = splitForSlack(monster);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(39_500);
    expect(chunks.join('')).toContain('x'.repeat(50_000));
  });
});
