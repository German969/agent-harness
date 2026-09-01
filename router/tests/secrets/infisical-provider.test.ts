import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock @infisical/sdk BEFORE importing the provider so the constructor picks up
// the mock. Each test controls behavior by mutating the shared spies below.

const loginSpy = vi.fn(async () => undefined);
const getSecretSpy = vi.fn();

vi.mock('@infisical/sdk', () => {
  class InfisicalSDK {
    auth() {
      return { universalAuth: { login: loginSpy } };
    }
    secrets() {
      return { getSecret: getSecretSpy };
    }
  }
  return { InfisicalSDK };
});

const { InfisicalSecretProvider } = await import('../../src/secrets/infisical-provider.js');
const { SecretNotFoundError } = await import('../../src/secrets/env-provider.js');

const baseCfg = {
  siteUrl: 'https://infisical.example.com',
  projectId: 'proj-1',
  environment: 'dev',
  clientId: 'ci',
  clientSecret: 'cs',
  cacheTtlMs: 60_000,
} as const;

beforeEach(() => {
  loginSpy.mockClear();
  getSecretSpy.mockReset();
});

describe('InfisicalSecretProvider', () => {
  it('logs in once and fetches a secret', async () => {
    getSecretSpy.mockResolvedValue({ secretValue: 'the-value' });
    const p = new InfisicalSecretProvider(baseCfg);

    const value = await p.getSecret('SLACK_BOT_TOKEN_strategist');

    expect(value).toBe('the-value');
    expect(loginSpy).toHaveBeenCalledTimes(1);
    expect(loginSpy).toHaveBeenCalledWith({ clientId: 'ci', clientSecret: 'cs' });
    expect(getSecretSpy).toHaveBeenCalledTimes(1);
    expect(getSecretSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: 'dev',
        projectId: 'proj-1',
        secretName: 'SLACK_BOT_TOKEN_strategist',
        viewSecretValue: true,
      }),
    );
  });

  it('caches values within the TTL window', async () => {
    getSecretSpy.mockResolvedValue({ secretValue: 'v' });
    const p = new InfisicalSecretProvider(baseCfg);

    await p.getSecret('K');
    await p.getSecret('K');
    await p.getSecret('K');

    expect(getSecretSpy).toHaveBeenCalledTimes(1);
    // Login only once too.
    expect(loginSpy).toHaveBeenCalledTimes(1);
  });

  it('re-auths and retries once on 401', async () => {
    getSecretSpy
      .mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { status: 401 }))
      .mockResolvedValueOnce({ secretValue: 'after-retry' });

    const p = new InfisicalSecretProvider(baseCfg);
    const value = await p.getSecret('K');

    expect(value).toBe('after-retry');
    expect(loginSpy).toHaveBeenCalledTimes(2); // initial login + re-auth after 401
    expect(getSecretSpy).toHaveBeenCalledTimes(2); // first (401) + retry
  });

  it('throws SecretNotFoundError on 404', async () => {
    getSecretSpy.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    const p = new InfisicalSecretProvider(baseCfg);
    await expect(p.getSecret('MISSING')).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it('throws SecretNotFoundError when the SDK returns an empty value', async () => {
    getSecretSpy.mockResolvedValue({ secretValue: '' });
    const p = new InfisicalSecretProvider(baseCfg);
    await expect(p.getSecret('EMPTY')).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it('propagates non-auth errors verbatim', async () => {
    getSecretSpy.mockRejectedValue(new Error('boom: DNS failure'));
    const p = new InfisicalSecretProvider(baseCfg);
    await expect(p.getSecret('K')).rejects.toThrow(/boom: DNS failure/);
  });

  it('serializes concurrent first-fetches into a single login', async () => {
    let resolveLogin: () => void = () => {};
    loginSpy.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          resolveLogin = r;
        }),
    );
    getSecretSpy.mockResolvedValue({ secretValue: 'v' });

    const p = new InfisicalSecretProvider(baseCfg);
    const [a, b, c] = [p.getSecret('A'), p.getSecret('B'), p.getSecret('C')];
    // Release the pending login.
    resolveLogin();
    await Promise.all([a, b, c]);

    expect(loginSpy).toHaveBeenCalledTimes(1);
    // Three separate secret fetches (one per unique name).
    expect(getSecretSpy).toHaveBeenCalledTimes(3);
  });
});
