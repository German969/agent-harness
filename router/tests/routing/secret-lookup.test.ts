import { describe, expect, it } from 'vitest';
import { buildRegistry, buildSecretLookup } from '../../src/routing/index.js';
import type { Identity } from '../../src/routing/schema.js';
import type { SecretProvider } from '../../src/secrets/index.js';

class StubProvider implements SecretProvider {
  readonly kind = 'env' as const;
  constructor(private readonly store: Record<string, string>) {}
  async getSecret(name: string): Promise<string> {
    const v = this.store[name];
    if (v === undefined) throw new Error(`missing: ${name}`);
    return v;
  }
}

const identities: Identity[] = [
  {
    agent: 'strategist',
    continuation_timeout_days: 30,
    github: { app_slug: 'strategist-bot', app_id: 100, bot_username: 's[bot]' },
    linear: { agent_handle: 's', webhook_id: 'wh-strat' },
    slack: { app_id: 'A-strat', bot_user_id: 'U-STRAT' },
    secrets: {
      github_webhook_secret: 'GITHUB_APP_WEBHOOK_SECRET_strategist',
      linear_webhook_secret: 'LINEAR_WEBHOOK_SECRET_strategist',
      slack_signing_secret: 'SLACK_SIGNING_SECRET_strategist',
    },
  },
];

describe('buildSecretLookup', () => {
  const reg = buildRegistry(identities);

  it('resolves GitHub webhook secret by App ID', async () => {
    const lookup = buildSecretLookup(
      reg,
      new StubProvider({ GITHUB_APP_WEBHOOK_SECRET_strategist: 'gh-sec-abc' }),
    );
    const result = await lookup({ provider: 'github', agent_hint: '100' });
    expect(result).toEqual({ found: true, agent: 'strategist', webhook_secret: 'gh-sec-abc' });
  });

  it('resolves Linear webhook secret by webhook_id', async () => {
    const lookup = buildSecretLookup(
      reg,
      new StubProvider({ LINEAR_WEBHOOK_SECRET_strategist: 'lin-sec' }),
    );
    const result = await lookup({ provider: 'linear', agent_hint: 'wh-strat' });
    expect(result).toEqual({ found: true, agent: 'strategist', webhook_secret: 'lin-sec' });
  });

  it('resolves Slack signing secret by app_id', async () => {
    const lookup = buildSecretLookup(
      reg,
      new StubProvider({ SLACK_SIGNING_SECRET_strategist: 'slack-sec' }),
    );
    const result = await lookup({ provider: 'slack', agent_hint: 'A-strat' });
    expect(result).toEqual({ found: true, agent: 'strategist', webhook_secret: 'slack-sec' });
  });

  it('returns not_found when hint does not match any agent', async () => {
    const lookup = buildSecretLookup(reg, new StubProvider({}));
    const result = await lookup({ provider: 'github', agent_hint: '99999' });
    expect(result.found).toBe(false);
    if (!result.found) expect(result.reason).toMatch(/no_agent_matches_hint/);
  });

  it('returns not_found when secret ref exists but secret is missing', async () => {
    const lookup = buildSecretLookup(reg, new StubProvider({})); // empty store
    const result = await lookup({ provider: 'github', agent_hint: '100' });
    expect(result.found).toBe(false);
    if (!result.found) expect(result.reason).toMatch(/secret_fetch_failed/);
  });

  it('returns not_found when identity has no secrets block', async () => {
    const regNoSecrets = buildRegistry([
      {
        agent: 'strategist',
        continuation_timeout_days: 30,
        github: { app_slug: 'x', app_id: 100, bot_username: 'x' },
        // no secrets block
      },
    ]);
    const lookup = buildSecretLookup(regNoSecrets, new StubProvider({}));
    const result = await lookup({ provider: 'github', agent_hint: '100' });
    expect(result.found).toBe(false);
    if (!result.found) expect(result.reason).toMatch(/identity_missing_secret_ref/);
  });
});
