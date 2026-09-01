import { describe, expect, it } from 'vitest';
import { SlackAlertPoster, renderAlertText } from '../../src/observability/slackAlertPoster.js';
import type { FetchLike } from '../../src/reply/types.js';

describe('renderAlertText', () => {
  it('composes title + body + fields', () => {
    const text = renderAlertText({
      agent: 'strategist',
      channel: '#a',
      level: 'warn',
      title: 'cap at 80%',
      body: 'agent strategist has crossed 80%',
      fields: { agent: 'strategist', percent: '85.0' },
    });
    expect(text).toContain('*cap at 80%*');
    expect(text).toContain('agent strategist has crossed 80%');
    expect(text).toContain('• *agent*: strategist');
    expect(text).toContain('• *percent*: 85.0');
  });

  it('skips fields section when none provided', () => {
    const text = renderAlertText({
      agent: 'strategist',
      channel: '#a',
      level: 'info',
      title: 't',
      body: 'b',
    });
    expect(text).not.toContain('•');
  });
});

describe('SlackAlertPoster', () => {
  function mockFetch(
    status = 200,
    body: object = { ok: true },
  ): {
    fetch: FetchLike;
    calls: Array<{ url: string; body: unknown }>;
  } {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(body), { status });
    };
    return { fetch, calls };
  }

  it('posts to chat.postMessage with bearer token + channel', async () => {
    const { fetch, calls } = mockFetch();
    const p = new SlackAlertPoster({ token: 'xoxb-tok', fetch });
    await p.post({
      agent: 'strategist',
      channel: '#agents-alerts',
      level: 'warn',
      title: 'cap',
      body: 'reached 80%',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://slack.com/api/chat.postMessage');
    const body = calls[0]?.body as { channel: string; text: string };
    expect(body.channel).toBe('#agents-alerts');
    expect(body.text).toContain('*cap*');
    expect(body.text).toContain('reached 80%');
  });

  it('falls back to defaultChannel when msg.channel is empty', async () => {
    const { fetch, calls } = mockFetch();
    const p = new SlackAlertPoster({
      token: 'xoxb',
      fetch,
      defaultChannel: '#fallback',
    });
    await p.post({
      agent: 'strategist',
      channel: '',
      level: 'error',
      title: 't',
      body: 'b',
    });
    const body = calls[0]?.body as { channel: string };
    expect(body.channel).toBe('#fallback');
  });

  it('calls onError with no channel + no default', async () => {
    const { fetch } = mockFetch();
    const errors: string[] = [];
    const p = new SlackAlertPoster({
      token: 'xoxb',
      fetch,
      onError: (e) => errors.push(e.message),
    });
    await p.post({
      agent: 'strategist',
      channel: '',
      level: 'info',
      title: 't',
      body: 'b',
    });
    expect(errors[0]).toContain('no channel');
  });

  it('surfaces Slack API errors via onError', async () => {
    const { fetch } = mockFetch(200, { ok: false, error: 'channel_not_found' });
    const errors: string[] = [];
    const p = new SlackAlertPoster({
      token: 'xoxb',
      fetch,
      onError: (e) => errors.push(e.message),
    });
    await p.post({
      agent: 'strategist',
      channel: '#missing',
      level: 'warn',
      title: 't',
      body: 'b',
    });
    expect(errors[0]).toContain('channel_not_found');
  });

  it('surfaces HTTP errors via onError', async () => {
    const { fetch } = mockFetch(429, {});
    const errors: string[] = [];
    const p = new SlackAlertPoster({
      token: 'xoxb',
      fetch,
      onError: (e) => errors.push(e.message),
    });
    await p.post({
      agent: 'strategist',
      channel: '#a',
      level: 'warn',
      title: 't',
      body: 'b',
    });
    expect(errors[0]).toContain('HTTP 429');
  });
});
