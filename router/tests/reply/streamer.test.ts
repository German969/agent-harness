// Streamer tests — exercise the runtime-facing surface + the footer path.

import { describe, expect, it } from 'vitest';
import { ReplyStreamer, buildReplyClient } from '../../src/reply/streamer.js';
import type { FetchLike } from '../../src/reply/types.js';

function captureFetch(): { fetch: FetchLike; calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes('slack.com')) {
      return new Response(JSON.stringify({ ok: true, ts: '1.0' }), { status: 200 });
    }
    if (url.includes('linear.app')) {
      return new Response(
        JSON.stringify({ data: { commentCreate: { success: true, comment: { id: 'c-1' } } } }),
        { status: 200 },
      );
    }
    if (url.includes('api.github.com')) {
      return new Response(JSON.stringify({ id: 42 }), { status: 201 });
    }
    return new Response('{}', { status: 200 });
  };
  return { fetch: fetchImpl, calls };
}

describe('buildReplyClient', () => {
  it('returns a SlackReplyClient for provider=slack', () => {
    const c = buildReplyClient({
      target: { provider: 'slack', channel: 'C', token: 't' },
    });
    expect(c.provider).toBe('slack');
  });

  it('returns a LinearReplyClient for provider=linear', () => {
    const c = buildReplyClient({
      target: { provider: 'linear', issue_id: 'issue-1', token: 't' },
    });
    expect(c.provider).toBe('linear');
  });

  it('returns a GitHubReplyClient for provider=github', () => {
    const c = buildReplyClient({
      target: {
        provider: 'github',
        owner: 'o',
        repo: 'r',
        issue_number: 1,
        token: 't',
      },
    });
    expect(c.provider).toBe('github');
  });
});

describe('ReplyStreamer', () => {
  it('accumulates chunks + appends footer on finalize (Slack)', async () => {
    const { fetch, calls } = captureFetch();
    const streamer = new ReplyStreamer({
      target: { provider: 'slack', channel: 'C-test', token: 'xoxb' },
      fetch,
    });
    streamer.push('Hello, ');
    await new Promise((r) => setImmediate(r));
    streamer.push('world.');
    await streamer.finalize({
      agent: 'strategist',
      skill: 'pjm',
      sessionId: 7,
      durationMs: 5000,
      costUsd: 0.03,
    });

    // The finalized post should contain the accumulated text AND the footer.
    const finalCall = calls[calls.length - 1];
    const text = (finalCall?.body as { text: string }).text;
    expect(text).toContain('Hello, world.');
    expect(text).toContain('@strategist-agent');
    expect(text).toContain('$0.03');
    expect(text).toContain('session `7`');
  });

  // A thinking-only assistant turn pushes no visible text. GitHub rejects a blank
  // comment body with HTTP 422, so a blank accumulation must not reach the client.
  it('does not send while the accumulated text is still blank', async () => {
    const { fetch, calls } = captureFetch();
    const streamer = new ReplyStreamer({
      target: {
        provider: 'github',
        owner: 'o',
        repo: 'r',
        issue_number: 8,
        token: 'ghp_xxx',
      },
      fetch,
    });

    streamer.push('');
    streamer.push('   ');
    streamer.push('\n\n');
    await new Promise((r) => setImmediate(r));
    expect(calls).toHaveLength(0);

    // Real text arrives → the whole accumulation is sent, leading blanks included.
    streamer.push('Received.');
    await new Promise((r) => setImmediate(r));
    expect(calls).toHaveLength(1);
    expect((calls[0]?.body as { body: string }).body).toContain('Received.');
  });

  it('finalize still posts when no text ever arrived (footer alone)', async () => {
    const { fetch, calls } = captureFetch();
    const streamer = new ReplyStreamer({
      target: {
        provider: 'github',
        owner: 'o',
        repo: 'r',
        issue_number: 8,
        token: 'ghp_xxx',
      },
      fetch,
    });

    streamer.push('');
    await streamer.finalize({
      agent: 'builder-server',
      sessionId: 1,
      durationMs: 1000,
      costUsd: 0.01,
    });

    // One post, and it is the footer — never a blank body.
    expect(calls).toHaveLength(1);
    const body = (calls[0]?.body as { body: string }).body;
    expect(body).toContain('session `1`');
    expect(body.trim()).not.toBe('');
  });

  it('routes to Linear GraphQL when target.provider=linear', async () => {
    const { fetch, calls } = captureFetch();
    const streamer = new ReplyStreamer({
      target: { provider: 'linear', issue_id: 'issue-abc', token: 'lin_api_xxx' },
      fetch,
    });
    await streamer.finalize({
      agent: 'strategist',
      sessionId: 1,
      durationMs: 1000,
      costUsd: 0.01,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('linear.app/graphql');
  });

  it('routes to GitHub REST when target.provider=github', async () => {
    const { fetch, calls } = captureFetch();
    const streamer = new ReplyStreamer({
      target: {
        provider: 'github',
        owner: 'acme',
        repo: 'core',
        issue_number: 123,
        token: 'ghp_xxx',
      },
      fetch,
    });
    await streamer.finalize({
      agent: 'builder-server',
      sessionId: 99,
      durationMs: 30_000,
      costUsd: 0.15,
    });
    expect(calls[0]?.url).toContain('api.github.com/repos/acme/core/issues/123/comments');
  });
});

describe('ReplyStreamer — unfinished sessions', () => {
  const target = { provider: 'slack', channel: 'C-test', token: 'xoxb' } as const;
  const footer = {
    agent: 'builder-server',
    skill: 'backend',
    sessionId: 275,
    durationMs: 383000,
    costUsd: 2.68,
  } as const;

  /** Body of the last Slack write — chat.update on edit, chat.postMessage on create. */
  function lastText(calls: Array<{ url: string; body: unknown }>): string {
    const posts = calls.filter((c) => c.url.includes('slack.com'));
    const last = posts[posts.length - 1]?.body as { text?: string } | undefined;
    return last?.text ?? '';
  }

  it('posts the notice above the footer when the turn limit was hit', async () => {
    const { fetch, calls } = captureFetch();
    const streamer = new ReplyStreamer({ target, fetch });
    streamer.push('Let me inspect the type definitions');
    await new Promise((r) => setImmediate(r));
    await streamer.finalize({ ...footer, outcome: 'max_turns_reached' });

    const text = lastText(calls);
    expect(text).toContain('Let me inspect the type definitions');
    expect(text).toContain('turn limit');
    // Notice must precede the footer: the footer is small print, the notice is
    // the part that stops a reader mistaking a cut-off session for an answer.
    expect(text.indexOf('turn limit')).toBeLessThan(text.indexOf('🤖 @'));
  });

  it('still says something when the session was cut off before speaking', async () => {
    // The blank-body guard means push() posts nothing; without the notice the
    // ticket would show no reply at all and look like the agent ignored it.
    const { fetch, calls } = captureFetch();
    const streamer = new ReplyStreamer({ target, fetch });
    await streamer.finalize({ ...footer, outcome: 'max_turns_reached' });
    expect(lastText(calls)).toContain('turn limit');
  });

  it('a completed session gets no notice', async () => {
    const { fetch, calls } = captureFetch();
    const streamer = new ReplyStreamer({ target, fetch });
    streamer.push('Done.');
    await new Promise((r) => setImmediate(r));
    await streamer.finalize({ ...footer, outcome: 'completed' });
    expect(lastText(calls)).not.toContain('turn limit');
  });

  it('drops the blank lines a thinking-only turn leaves in front of the text', async () => {
    const { fetch, calls } = captureFetch();
    const streamer = new ReplyStreamer({ target, fetch });
    streamer.push('\n\n\n\n\n');
    streamer.push('The actual answer.');
    await new Promise((r) => setImmediate(r));
    await streamer.finalize({ ...footer, outcome: 'completed' });
    expect(lastText(calls)).toMatch(/^The actual answer\./);
  });
});
