import { describe, expect, it } from 'vitest';
import {
  type IdentitySecretsBlock,
  type SecretProvider,
  resolveSecrets,
  resolveSecretsWithExtras,
} from '../../src/secrets/index.js';

/** Deterministic stub provider — no real secret backend needed for these tests. */
class StubProvider implements SecretProvider {
  readonly kind = 'env' as const;
  /** Every name this provider was asked for, in order. */
  readonly requested: string[] = [];
  constructor(private readonly store: Record<string, string>) {}
  async getSecret(name: string): Promise<string> {
    this.requested.push(name);
    const value = this.store[name];
    if (value === undefined) throw new Error(`missing: ${name}`);
    return value;
  }
}

describe('resolveSecrets', () => {
  it('maps identity block LHS to uppercased env-var names', async () => {
    const provider = new StubProvider({
      LINEAR_TOKEN_strategist: 'lin-abc',
      GITHUB_APP_PRIVATE_KEY_strategist: 'gh-priv',
    });
    const identity: IdentitySecretsBlock = {
      linear_token: 'LINEAR_TOKEN_strategist',
      github_app_private_key: 'GITHUB_APP_PRIVATE_KEY_strategist',
    };
    const env = await resolveSecrets(provider, identity);
    expect(env).toEqual({
      LINEAR_TOKEN: 'lin-abc',
      GITHUB_APP_PRIVATE_KEY: 'gh-priv',
    });
  });

  it('per-agent isolation — different Infisical names for the same role', async () => {
    const provider = new StubProvider({
      LINEAR_TOKEN_strategist: 'strategist-val',
      LINEAR_TOKEN_marketer: 'marketer-val',
    });
    const strategist = await resolveSecrets(provider, {
      linear_token: 'LINEAR_TOKEN_strategist',
    });
    const marketer = await resolveSecrets(provider, {
      linear_token: 'LINEAR_TOKEN_marketer',
    });
    expect(strategist.LINEAR_TOKEN).toBe('strategist-val');
    expect(marketer.LINEAR_TOKEN).toBe('marketer-val');
    // Cross-agent secrets never appear in each other's env
    expect(strategist).not.toHaveProperty('marketer-val');
    expect(marketer).not.toHaveProperty('strategist-val');
  });

  it('empty identity block → empty env map', async () => {
    const provider = new StubProvider({});
    const env = await resolveSecrets(provider, {});
    expect(env).toEqual({});
  });

  it('throws when a named secret is not found', async () => {
    const provider = new StubProvider({});
    await expect(resolveSecrets(provider, { linear_token: 'MISSING_KEY' })).rejects.toThrow(
      /missing: MISSING_KEY/,
    );
  });

  // A `~` ref declares the agent deliberately has no such secret. Before this,
  // every agent needed a credential for every surface — builder-server has no
  // Slack app but still had to hold a SLACK_BOT_TOKEN or no session could start.
  it('skips a null ref instead of fetching it', async () => {
    const provider = new StubProvider({ GITHUB_APP_PRIVATE_KEY_x: 'gh-priv' });
    const env = await resolveSecrets(provider, {
      github_app_private_key: 'GITHUB_APP_PRIVATE_KEY_x',
      slack_bot_token: null,
      linear_webhook_secret: null,
    });

    expect(env).toEqual({ GITHUB_APP_PRIVATE_KEY: 'gh-priv' });
    // Absent, not empty-string — downstream tests presence to decide if a surface is on.
    expect(env).not.toHaveProperty('SLACK_BOT_TOKEN');
    expect(provider.requested).toEqual(['GITHUB_APP_PRIVATE_KEY_x']);
  });

  it('reports every missing secret at once, not just the first', async () => {
    const provider = new StubProvider({ PRESENT: 'ok' });
    const promise = resolveSecrets(provider, {
      a: 'PRESENT',
      b: 'MISSING_ONE',
      c: 'MISSING_TWO',
    });

    await expect(promise).rejects.toThrow(/2 secrets could not be resolved/);
    await expect(promise).rejects.toThrow(/MISSING_ONE \(b\)/);
    await expect(promise).rejects.toThrow(/MISSING_TWO \(c\)/);
  });

  it('singularizes the message for exactly one missing secret', async () => {
    const provider = new StubProvider({});
    await expect(resolveSecrets(provider, { a: 'MISSING_ONE' })).rejects.toThrow(
      /^1 secret could not be resolved/,
    );
  });

  it('resolves all-uppercase LHS keys as-is (no double-uppercase)', async () => {
    const provider = new StubProvider({ SOME_KEY: 'v' });
    const env = await resolveSecrets(provider, { SOME_KEY: 'SOME_KEY' });
    expect(env.SOME_KEY).toBe('v');
  });
});

describe('resolveSecretsWithExtras', () => {
  it('merges non-secret extras with resolved secrets', async () => {
    const provider = new StubProvider({ LINEAR_TOKEN_x: 'sec' });
    const env = await resolveSecretsWithExtras(
      provider,
      { linear_token: 'LINEAR_TOKEN_x' },
      { SLACK_TEAM_ID: 'T012345' }, // non-secret public ID
    );
    expect(env).toEqual({
      SLACK_TEAM_ID: 'T012345',
      LINEAR_TOKEN: 'sec',
    });
  });

  it('secrets override extras with the same key (safety default)', async () => {
    const provider = new StubProvider({ LINEAR_TOKEN_x: 'from-secret' });
    const env = await resolveSecretsWithExtras(
      provider,
      { linear_token: 'LINEAR_TOKEN_x' },
      { LINEAR_TOKEN: 'from-extras' }, // extra with the same name — should be overridden
    );
    // Secret provider wins; a leaked extras key shouldn't silently supersede
    expect(env.LINEAR_TOKEN).toBe('from-secret');
  });
});
