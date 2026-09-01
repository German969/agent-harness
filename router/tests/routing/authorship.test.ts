import { describe, expect, it } from 'vitest';
import type { WebhookEvent } from '../../src/ingress/types.js';
import { renderFooter } from '../../src/reply/footer.js';
import { isAgentAuthoredEvent } from '../../src/routing/authorship.js';
import { buildRegistry } from '../../src/routing/index.js';
import type { Identity } from '../../src/routing/schema.js';

function identity(agent: 'strategist'): Identity {
  return {
    agent,
    github: { app_id: '111', app_slug: 'dev-team-strategist', bot_username: 'strategist-agent' },
    linear: {},
    slack: { app_id: 'A1', bot_user_id: 'U-STRAT', channels: {} },
    continuation_timeout_days: 30,
    secrets: {},
  } as unknown as Identity;
}

const registry = buildRegistry([identity('strategist')]);

function ev(partial: Partial<WebhookEvent>): WebhookEvent {
  return {
    provider: 'github',
    delivery_id: 'd',
    event_type: 'issue_comment.created',
    agent_hint: '111',
    payload: {},
    received_at: Date.now(),
    ...partial,
  } as WebhookEvent;
}

describe('isAgentAuthoredEvent — GitHub', () => {
  it('recognises one of our own apps as the author', () => {
    const e = ev({ payload: { sender: { login: 'dev-team-strategist[bot]' } } });
    expect(isAgentAuthoredEvent(registry, e)).toBe(true);
  });

  it('treats a human as human', () => {
    const e = ev({ payload: { sender: { login: 'German969' } } });
    expect(isAgentAuthoredEvent(registry, e)).toBe(false);
  });

  it('does not count a third-party bot as one of our agents', () => {
    // Dependabot commenting repeatedly is not an agent-to-agent coordination
    // chain, and counting it would refuse sessions for the wrong reason.
    const e = ev({ payload: { sender: { login: 'dependabot[bot]', type: 'Bot' } } });
    expect(isAgentAuthoredEvent(registry, e)).toBe(false);
  });
});

describe('isAgentAuthoredEvent — Slack', () => {
  it('bot_id marks an app-posted message', () => {
    const e = ev({ provider: 'slack', payload: { event: { bot_id: 'B123', text: 'hi' } } });
    expect(isAgentAuthoredEvent(registry, e)).toBe(true);
  });

  it("an agent's own bot_user_id counts", () => {
    const e = ev({ provider: 'slack', payload: { event: { user: 'U-STRAT', text: 'hi' } } });
    expect(isAgentAuthoredEvent(registry, e)).toBe(true);
  });

  it('a person in the same channel does not', () => {
    const e = ev({ provider: 'slack', payload: { event: { user: 'U-HUMAN', text: 'hi' } } });
    expect(isAgentAuthoredEvent(registry, e)).toBe(false);
  });
});

describe('isAgentAuthoredEvent — Linear', () => {
  it('botActor marks an app-created comment', () => {
    const e = ev({
      provider: 'linear',
      payload: { data: { botActor: { id: 'bot_1', type: 'app' }, body: 'hello' } },
    });
    expect(isAgentAuthoredEvent(registry, e)).toBe(true);
  });

  it('a human comment has a null botActor', () => {
    const e = ev({ provider: 'linear', payload: { data: { botActor: null, body: 'hello' } } });
    expect(isAgentAuthoredEvent(registry, e)).toBe(false);
  });

  it('falls back to our own reply footer when botActor is absent', () => {
    // The fleet shares one Linear OAuth app, so there is no per-agent id to match;
    // if a payload omits botActor entirely, the footer we wrote is the signal.
    const body = `Here is my answer.${renderFooter({
      agent: 'strategist',
      handle: 'strategist-agent',
      skill: 'conversational',
      durationMs: 8000,
      costUsd: 0.01,
      sessionId: 213,
    })}`;
    const e = ev({ provider: 'linear', payload: { data: { body } } });
    expect(isAgentAuthoredEvent(registry, e)).toBe(true);
  });

  it('a human who merely quotes the robot emoji is still human', () => {
    const e = ev({
      provider: 'linear',
      payload: { data: { body: 'the 🤖 @strategist-agent reply above was wrong' } },
    });
    expect(isAgentAuthoredEvent(registry, e)).toBe(false);
  });
});
