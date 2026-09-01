// Secrets abstraction.
// Per router/ARCHITECTURE.md §2.10 — secrets never touch disk; fetched per session;
// scoped to the session's env vars; discarded after session end.

/**
 * The `secrets:` block from identities/<agent>.yml. Keys are semantic role names
 * (e.g. `github_app_private_key`); values are the corresponding Infisical secret names
 * (e.g. `GITHUB_APP_PRIVATE_KEY_strategist`).
 */
export type IdentitySecretsBlock = Record<string, string | null>;

/**
 * The resolved env-var map for a session. Keys are the semantic role names
 * uppercased (e.g. `GITHUB_APP_PRIVATE_KEY`); values are the actual secret values
 * fetched from the secret provider.
 *
 * This map is injected into the SDK call + MCP child processes' env, then discarded.
 */
export type SessionEnv = Record<string, string>;

/**
 * A secret provider — the abstraction the resolver + runtime depend on.
 * Implementations: EnvSecretProvider (dev/test), InfisicalSecretProvider (prod).
 */
export interface SecretProvider {
  /**
   * Fetch a single secret by its provider-side name (e.g. `LINEAR_TOKEN_strategist`).
   * Throws if the secret does not exist or the provider is unreachable.
   */
  getSecret(name: string): Promise<string>;

  /** Provider identity, for logging / health checks. */
  readonly kind: 'env' | 'infisical';
}

/**
 * A secret name is considered "well-formed" if it's ALL_UPPER_SNAKE_CASE.
 * Not enforced at the provider layer, but tests + validators use this.
 */
export function isWellFormedSecretName(name: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(name);
}
