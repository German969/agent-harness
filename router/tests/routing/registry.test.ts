import { describe, expect, it } from 'vitest';
import { buildRegistry, findAgentByHint } from '../../src/routing/index.js';
import type { Identity } from '../../src/routing/schema.js';

function fx(agent: Identity['agent'], overrides: Partial<Identity> = {}): Identity {
  return {
    agent,
    continuation_timeout_days: 30,
    ...overrides,
  } as Identity;
}

describe('buildRegistry', () => {
  it('indexes GitHub App IDs', () => {
    const reg = buildRegistry([
      fx('strategist', { github: { app_slug: 's', app_id: 100, bot_username: 's[bot]' } }),
      fx('guardian', { github: { app_slug: 'g', app_id: 200, bot_username: 'g[bot]' } }),
    ]);
    expect(reg.githubByAppId.get('100')).toBe('strategist');
    expect(reg.githubByAppId.get('200')).toBe('guardian');
  });

  it('indexes Slack app IDs + bot user IDs', () => {
    const reg = buildRegistry([
      fx('strategist', {
        slack: { app_id: 'A100', bot_user_id: 'U100' },
      }),
    ]);
    expect(reg.slackByAppId.get('A100')).toBe('strategist');
    expect(reg.slackByBotUserId.get('U100')).toBe('strategist');
  });

  it('indexes Linear webhook_id + agent_id + user_id', () => {
    const reg = buildRegistry([
      fx('marketer', {
        linear: {
          agent_handle: 'marketer-bot',
          webhook_id: 'wh-marketer',
          agent_id: 'agent_m',
          user_id: 'usr_m',
        },
      }),
    ]);
    expect(reg.linearByWebhookId.get('wh-marketer')).toBe('marketer');
    expect(reg.linearByAgentId.get('agent_m')).toBe('marketer');
    expect(reg.linearByUserId.get('usr_m')).toBe('marketer');
  });

  it('indexes routing rules (labels, channels, auto-triggers)', () => {
    const reg = buildRegistry([
      fx('guardian', {
        routing: {
          linear_labels: ['security', 'perf'],
          slack_default_channels: ['#security'],
          github_auto_triggers: ['pull_request.opened'],
        },
      }),
      fx('strategist', {
        routing: { linear_labels: ['prd'] },
      }),
    ]);
    expect(reg.labelToAgent.get('security')).toBe('guardian');
    expect(reg.labelToAgent.get('perf')).toBe('guardian');
    expect(reg.labelToAgent.get('prd')).toBe('strategist');
    expect(reg.slackChannelDefault.get('#security')).toBe('guardian');
    expect(reg.githubAutoTriggers.get('pull_request.opened')).toBe('guardian');
  });

  it('skips null / undefined identifying fields', () => {
    const reg = buildRegistry([
      fx('guardian', {
        github: { app_slug: 'g', app_id: null, bot_username: 'g[bot]' },
      }),
    ]);
    expect(reg.githubByAppId.size).toBe(0);
  });

  it('first-writer wins on label collisions', () => {
    const reg = buildRegistry([
      fx('guardian', { routing: { linear_labels: ['security'] } }),
      fx('strategist', { routing: { linear_labels: ['security'] } }),
    ]);
    expect(reg.labelToAgent.get('security')).toBe('guardian');
  });
});

describe('findAgentByHint', () => {
  const reg = buildRegistry([
    fx('strategist', { github: { app_slug: 's', app_id: 100, bot_username: 's' } }),
    fx('guardian', { github: { app_slug: 'g', app_id: 200, bot_username: 'g' } }),
    fx('marketer', {
      linear: { agent_handle: 'm', webhook_id: 'wh-m' },
      slack: { app_id: 'A-m', bot_user_id: 'U-m' },
    }),
  ]);

  it('resolves GitHub by App ID', () => {
    expect(findAgentByHint(reg, 'github', '200')).toBe('guardian');
  });
  it('resolves Linear by webhook_id', () => {
    expect(findAgentByHint(reg, 'linear', 'wh-m')).toBe('marketer');
  });
  it('resolves Slack by app_id', () => {
    expect(findAgentByHint(reg, 'slack', 'A-m')).toBe('marketer');
  });
  it('returns undefined for unknown hints', () => {
    expect(findAgentByHint(reg, 'github', '9999')).toBeUndefined();
  });
});
