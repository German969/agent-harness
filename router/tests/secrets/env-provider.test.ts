import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EnvSecretProvider, SecretNotFoundError } from '../../src/secrets/index.js';

describe('EnvSecretProvider', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('kind is "env"', () => {
    expect(new EnvSecretProvider().kind).toBe('env');
  });

  it('returns the value when the env var exists', async () => {
    process.env.SOME_TEST_SECRET = 'test-value-42';
    const p = new EnvSecretProvider();
    await expect(p.getSecret('SOME_TEST_SECRET')).resolves.toBe('test-value-42');
  });

  it('throws SecretNotFoundError when the env var is missing', async () => {
    // biome-ignore lint/performance/noDelete: process.env requires delete; assigning undefined sets it to the string "undefined"
    delete process.env.DEFINITELY_NOT_SET_XYZ;
    const p = new EnvSecretProvider();
    await expect(p.getSecret('DEFINITELY_NOT_SET_XYZ')).rejects.toThrow(SecretNotFoundError);
  });

  it('throws when the env var is empty string', async () => {
    process.env.EMPTY_VAR = '';
    const p = new EnvSecretProvider();
    await expect(p.getSecret('EMPTY_VAR')).rejects.toThrow(SecretNotFoundError);
  });

  it('SecretNotFoundError carries name + provider', async () => {
    const p = new EnvSecretProvider();
    try {
      await p.getSecret('NO_SUCH_SECRET');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SecretNotFoundError);
      const e = err as SecretNotFoundError;
      expect(e.name).toBe('SecretNotFoundError');
      expect(e.secretName).toBe('NO_SUCH_SECRET');
      expect(e.provider).toBe('env');
    }
  });
});
