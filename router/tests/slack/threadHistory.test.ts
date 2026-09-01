import { describe, expect, it, vi } from 'vitest';
import { fetchSlackThread, formatThreadAsContext } from '../../src/slack/threadHistory.js';

describe('fetchSlackThread', () => {
  it('returns messages on ok=true', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            messages: [
              { ts: '1700000001.000000', user: 'U1', text: 'hi' },
              { ts: '1700000002.000000', bot_id: 'B1', text: 'hello' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    const msgs = await fetchSlackThread({
      botToken: 'xoxb-test',
      channel: 'C1',
      thread_ts: '1700000001.000000',
      fetch: fetchMock,
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.user).toBe('U1');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain('/api/conversations.replies');
    expect(String(url)).toContain('channel=C1');
    expect(String(url)).toContain('ts=1700000001.000000');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer xoxb-test',
    });
  });

  it('throws on ok=false', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error: 'not_in_channel' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    await expect(
      fetchSlackThread({
        botToken: 't',
        channel: 'C1',
        thread_ts: '1',
        fetch: fetchMock,
      }),
    ).rejects.toThrow('not_in_channel');
  });

  it('throws on non-2xx HTTP status', async () => {
    const fetchMock = vi.fn(async () => new Response('server error', { status: 500 }));
    await expect(
      fetchSlackThread({
        botToken: 't',
        channel: 'C1',
        thread_ts: '1',
        fetch: fetchMock,
      }),
    ).rejects.toThrow('HTTP 500');
  });
});

describe('formatThreadAsContext', () => {
  it('formats human + bot messages with iso timestamps', () => {
    const out = formatThreadAsContext([
      { ts: '1700000001.000000', user: 'U1', text: 'first' },
      { ts: '1700000002.000000', bot_id: 'B1', text: 'second' },
    ]);
    expect(out).toContain('<@U1>: first');
    expect(out).toContain('@bot(B1): second');
    // Two messages → paragraph-separated.
    expect(out.split('\n\n')).toHaveLength(2);
  });

  it('excludes the message matching currentTs', () => {
    const out = formatThreadAsContext(
      [
        { ts: '1', user: 'U1', text: 'old' },
        { ts: '2', user: 'U1', text: 'newest — the trigger' },
      ],
      { currentTs: '2' },
    );
    expect(out).toContain('old');
    expect(out).not.toContain('newest — the trigger');
  });

  it('returns empty string when nothing survives filtering', () => {
    const out = formatThreadAsContext(
      [{ ts: '1', user: 'U1', text: 'only message is the trigger' }],
      { currentTs: '1' },
    );
    expect(out).toBe('');
  });
});
