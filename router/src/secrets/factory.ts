// Factory — picks a SecretProvider implementation based on config.
// Called once at router startup; the resulting provider is shared across all sessions.

import { EnvSecretProvider } from './env-provider.js';
import { InfisicalSecretProvider } from './infisical-provider.js';
import type { SecretProvider } from './types.js';

export type SecretProviderKind = 'env' | 'infisical';

export type FactoryConfig = {
  kind: SecretProviderKind;
  infisical?: {
    siteUrl: string;
    projectId: string;
    environment: string;
    clientId: string;
    clientSecret: string;
  };
};

export function createSecretProvider(cfg: FactoryConfig): SecretProvider {
  switch (cfg.kind) {
    case 'env':
      return new EnvSecretProvider();
    case 'infisical': {
      if (!cfg.infisical) {
        throw new Error(
          'SECRETS_PROVIDER=infisical requires infisical config (siteUrl, projectId, environment, clientId, clientSecret)',
        );
      }
      return new InfisicalSecretProvider(cfg.infisical);
    }
  }
}
