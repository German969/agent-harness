// EnvSecretProvider — reads secrets from process.env.
//
// Used for local dev + tests. Not for production (see InfisicalSecretProvider).
// The router reads a .env file at startup (config.ts does this via dotenv), so
// developers can populate ./router/.env with `LINEAR_TOKEN_strategist=...` etc.
// and the resolver picks them up.

import type { SecretProvider } from './types.js';

export class EnvSecretProvider implements SecretProvider {
  readonly kind = 'env' as const;

  async getSecret(name: string): Promise<string> {
    const value = process.env[name];
    if (value === undefined || value === '') {
      throw new SecretNotFoundError(name, 'env');
    }
    return value;
  }
}

export class SecretNotFoundError extends Error {
  override readonly name = 'SecretNotFoundError';

  constructor(
    public readonly secretName: string,
    public readonly provider: string,
  ) {
    super(`Secret not found in ${provider} provider: ${secretName}`);
  }
}
