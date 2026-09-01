import { describe, expect, it } from 'vitest';
import type { WebhookEvent } from '../../src/ingress/types.js';
import { resolveSkill } from '../../src/routing/skill.js';

/** Minimal Slack event carrying `text` (where selectors/mentions are read from). */
function slack(text: string): WebhookEvent {
  return {
    provider: 'slack',
    delivery_id: 'd1',
    event_type: 'app_mention',
    agent_hint: 'U0BOT',
    payload: { event: { text } },
    received_at: 0,
  };
}

describe('resolveSkill — conversational vs work default', () => {
  it('routes a bare mention (no work trigger) to the conversational skill', () => {
    for (const agent of [
      'platform',
      'guardian',
      'builder-server',
      'builder-client',
      'marketer',
      'harness',
    ] as const) {
      expect(resolveSkill(agent, slack('<@U0BOT> hello'))).toBe('conversational');
    }
  });

  it("routes a work auto-trigger to the agent's work default, not conversational", () => {
    const cases = {
      platform: 'architect',
      guardian: 'qa',
      'builder-server': 'backend',
      'builder-client': 'frontend',
      marketer: 'campaign-lead',
      harness: 'agent-modifier',
    } as const;
    for (const [agent, skill] of Object.entries(cases)) {
      expect(
        resolveSkill(agent as keyof typeof cases, slack('please review'), { workTrigger: true }),
      ).toBe(skill);
    }
  });

  it('an explicit selector still wins over both defaults', () => {
    // Platform `adr` selector → architect even without a work trigger…
    expect(resolveSkill('platform', slack('<@U0BOT> adr export pattern'))).toBe('architect');
    // …and Guardian `threat-model` → security even on a bare mention.
    expect(resolveSkill('guardian', slack('<@U0BOT> threat-model the API'))).toBe('security');
  });

  it('strategist keeps its phrase intents and conversational default', () => {
    expect(resolveSkill('strategist', slack('<@U0BOT> what tech are we using?'))).toBe(
      'conversational',
    );
    expect(resolveSkill('strategist', slack('<@U0BOT> kick off phase 0'))).toBe('founding');
    // An unlabeled work assignment falls back to conversational (route/escalate).
    expect(resolveSkill('strategist', slack('do the thing'), { workTrigger: true })).toBe(
      'conversational',
    );
  });
});
