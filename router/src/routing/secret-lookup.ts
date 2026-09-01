// Real SecretLookup — replaces the Phase 3 stub in server.ts.
//
// Given a provider + agent_hint (App ID / Linear webhook_id / Slack app_id):
//   1. Match against the routing registry to find the agent
//   2. Fetch the agent's webhook_secret via the SecretProvider
//   3. Return { found: true, agent, webhook_secret }
//
// If the hint doesn't match any agent, or the identity doesn't declare a
// webhook_secret ref, or the secret isn't available, return { found: false }.

import type { SecretLookup } from '../ingress/types.js';
import type { SecretProvider } from '../secrets/index.js';
import type { Provider } from '../types.js';
import { type Registry, findAgentByHint } from './registry.js';

const WEBHOOK_SECRET_ROLE: Record<Provider, string> = {
  github: 'github_webhook_secret',
  linear: 'linear_webhook_secret',
  slack: 'slack_signing_secret',
};

export function buildSecretLookup(
  registry: Registry,
  secretProvider: SecretProvider,
): SecretLookup {
  return async ({ provider, agent_hint }) => {
    const agent = findAgentByHint(registry, provider, agent_hint);
    if (!agent) {
      return { found: false, reason: `no_agent_matches_hint_${provider}` };
    }

    const identity = registry.byAgent.get(agent);
    if (!identity) return { found: false, reason: 'internal_registry_inconsistency' };

    const role = WEBHOOK_SECRET_ROLE[provider];
    const secretRef = identity.secrets?.[role];
    if (!secretRef) {
      return { found: false, reason: `identity_missing_secret_ref: ${role}` };
    }

    try {
      const value = await secretProvider.getSecret(secretRef);
      return { found: true, agent, webhook_secret: value };
    } catch (err) {
      return {
        found: false,
        reason: `secret_fetch_failed: ${(err as Error).message}`,
      };
    }
  };
}
