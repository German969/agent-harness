// Resolver — given an agent's `secrets:` block from identities/<agent>.yml,
// fetch all named secrets from the provider and return an env-var map.
//
// Mapping rule:
//   identity yaml: `github_app_private_key: GITHUB_APP_PRIVATE_KEY_strategist`
//                  → fetch `GITHUB_APP_PRIVATE_KEY_strategist` from provider
//                  → return `{ GITHUB_APP_PRIVATE_KEY: '<value>' }` (LHS uppercased)
//
// The uppercased LHS becomes the env-var name that MCP configs reference via ${VAR}.
// This is what decouples the identity-side name (Infisical namespace) from the
// runtime-side name (MCP env var).

import type { IdentitySecretsBlock, SecretProvider, SessionEnv } from './types.js';

/**
 * Fetch every secret named in the identity block; return an env-var map.
 * Order-preserving with respect to input keys.
 *
 * A `null` ref (`slack_bot_token: ~`) is skipped, not fetched: it declares that this
 * agent deliberately has no such secret. Downstream already treats an absent key as
 * "that surface is off" — the in-process Linear MCP logs `no LINEAR_TOKEN in session
 * env` and skips, replyTarget falls through without a SLACK_BOT_TOKEN — so the only
 * thing forcing every agent to hold a credential for every surface was this function.
 * Skipping is explicit and visible in the identity file, unlike a dummy value.
 *
 * Fetch failures do NOT abort on the first one. Every ref is attempted and all
 * failures are reported together, so bringing an agent online is one round trip
 * rather than one per missing secret.
 */
export async function resolveSecrets(
  provider: SecretProvider,
  identitySecrets: IdentitySecretsBlock,
): Promise<SessionEnv> {
  const env: SessionEnv = {};
  const failures: string[] = [];

  for (const [role, providerName] of Object.entries(identitySecrets)) {
    if (providerName === null) continue;
    try {
      env[role.toUpperCase()] = await provider.getSecret(providerName);
    } catch (err) {
      failures.push(`${providerName} (${role}): ${(err as Error).message}`);
    }
  }

  if (failures.length > 0) {
    const label = failures.length === 1 ? '1 secret' : `${failures.length} secrets`;
    throw new Error(`${label} could not be resolved — ${failures.join('; ')}`);
  }

  return env;
}

/**
 * Convenience: resolve secrets AND merge in additional non-secret env vars
 * (e.g. SLACK_TEAM_ID which is public but lives in the identity file for convenience).
 */
export async function resolveSecretsWithExtras(
  provider: SecretProvider,
  identitySecrets: IdentitySecretsBlock,
  extras: SessionEnv,
): Promise<SessionEnv> {
  const resolved = await resolveSecrets(provider, identitySecrets);
  return { ...extras, ...resolved };
}
