// Public surface of the secrets module.

export type {
  IdentitySecretsBlock,
  SecretProvider,
  SessionEnv,
} from './types.js';
export { isWellFormedSecretName } from './types.js';
export { EnvSecretProvider, SecretNotFoundError } from './env-provider.js';
export { InfisicalSecretProvider } from './infisical-provider.js';
export { resolveSecrets, resolveSecretsWithExtras } from './resolver.js';
export { createSecretProvider, type FactoryConfig, type SecretProviderKind } from './factory.js';
export { pinoRedact, redactPaths, redactCensor } from './log-redact.js';
