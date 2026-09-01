import { describe, expect, it } from 'vitest';
import { renderFooter, renderOutcomeNotice } from '../../src/reply/footer.js';

describe('renderFooter', () => {
  it('includes agent, skill, duration, cost, session_id', () => {
    const out = renderFooter({
      agent: 'strategist',
      skill: 'pjm',
      sessionId: 42,
      durationMs: 12_500,
      costUsd: 0.077,
    });
    expect(out).toContain('@strategist-agent');
    expect(out).toContain('pjm');
    expect(out).toContain('13s'); // rounded
    expect(out).toContain('$0.08');
    expect(out).toContain('session `42`');
  });

  it('omits skill when not provided', () => {
    const out = renderFooter({
      agent: 'strategist',
      sessionId: 1,
      durationMs: 500,
      costUsd: 0.01,
    });
    expect(out).toContain('@strategist-agent');
    expect(out).toContain('500ms');
    // No 'pjm' or any other skill string.
    expect(out).toMatch(/@strategist-agent • \d+ms • \$0\.01 • session/);
  });

  it('renders a link when logLinkBase is set', () => {
    const out = renderFooter({
      agent: 'guardian',
      sessionId: 7,
      durationMs: 60_000,
      costUsd: 0.5,
      logLinkBase: 'https://example.com/logs/',
    });
    expect(out).toContain('[`7`](https://example.com/logs/7)');
  });

  it('shows the responding session id + a thread-root note (cost belongs to the responder)', () => {
    const out = renderFooter({
      agent: 'strategist',
      sessionId: 42,
      rootSessionId: 40,
      durationMs: 1000,
      costUsd: 0,
    });
    // The responding session (42) is shown — matching its own cost/duration —
    // with the thread root (40) noted for grouping, not substituted for it.
    expect(out).toContain('session `42`');
    expect(out).toContain('(thread `40`)');
  });

  it('links the responding session and notes the thread root when logLinkBase is set', () => {
    const out = renderFooter({
      agent: 'strategist',
      sessionId: 42,
      rootSessionId: 40,
      durationMs: 1000,
      costUsd: 0,
      logLinkBase: 'https://example.com/logs/',
    });
    // Link points at the responding session's own log.
    expect(out).toContain('[`42`](https://example.com/logs/42)');
    expect(out).toContain('(thread `40`)');
  });

  it('omits the thread note when the session is the thread root', () => {
    const out = renderFooter({
      agent: 'strategist',
      sessionId: 40,
      rootSessionId: 40,
      durationMs: 1000,
      costUsd: 0,
    });
    expect(out).toContain('session `40`');
    expect(out).not.toContain('thread');
  });

  it('formats durations across bands', () => {
    const under1s = renderFooter({
      agent: 'strategist',
      sessionId: 1,
      durationMs: 250,
      costUsd: 0,
    });
    expect(under1s).toContain('250ms');

    const minutes = renderFooter({
      agent: 'strategist',
      sessionId: 1,
      durationMs: 125_000,
      costUsd: 0,
    });
    expect(minutes).toContain('2m5s');

    const hours = renderFooter({
      agent: 'strategist',
      sessionId: 1,
      durationMs: 3_690_000, // 61m30s
      costUsd: 0,
    });
    expect(hours).toContain('1h1m');
  });
});

describe('renderOutcomeNotice', () => {
  it('says nothing for a completed session', () => {
    expect(renderOutcomeNotice('completed')).toBe('');
    expect(renderOutcomeNotice(undefined)).toBe('');
  });

  it('warns that a turn-limit stop is not a finished result', () => {
    const notice = renderOutcomeNotice('max_turns_reached');
    expect(notice).toContain('turn limit');
    expect(notice).toContain('not a finished result');
    // The reader has to learn nothing was saved — otherwise the natural
    // assumption is that partial work is sitting on a branch somewhere.
    expect(notice).toContain('nothing was committed');
  });

  it('warns on cancelled and error too', () => {
    expect(renderOutcomeNotice('cancelled')).toContain('cancelled');
    expect(renderOutcomeNotice('error')).toContain('error');
  });
});
