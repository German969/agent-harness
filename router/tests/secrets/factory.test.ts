import { describe, expect, it } from 'vitest';
import { createSecretProvider } from '../../src/secrets/index.js';

describe('createSecretProvider', () => {
  it('returns an EnvSecretProvider for kind=env', () => {
    const p = createSecretProvider({ kind: 'env' });
    expect(p.kind).toBe('env');
  });

  it('returns an InfisicalSecretProvider for kind=infisical', () => {
    const p = createSecretProvider({
      kind: 'infisical',
      infisical: {
        siteUrl: 'https://infisical.local',
        projectId: 'proj',
        environment: 'prod',
        clientId: 'ci',
        clientSecret: 'cs',
      },
    });
    expect(p.kind).toBe('infisical');
  });

  it('throws if infisical config is missing', () => {
    expect(() => createSecretProvider({ kind: 'infisical' })).toThrow(/requires infisical config/);
  });
});
