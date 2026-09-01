// Ingress type definitions. Normalized WebhookEvent that the classifier (Phase 4)
// consumes; per-provider raw payload types stay in normalize/.

import type { Provider } from '../types.js';

/**
 * A verified + dedup'd webhook event, ready for classification.
 * The `payload` field holds the raw provider-specific JSON (unmodified except
 * for JSON.parse); the top-level fields are the router's normalized abstraction.
 */
export type WebhookEvent = {
  /** Provider that sent the webhook. */
  provider: Provider;
  /** Provider-specific delivery ID (used for idempotency dedup). */
  delivery_id: string;
  /** Event type in the provider's own vocabulary (e.g. 'pull_request.opened', 'app_mention'). */
  event_type: string;
  /**
   * Identifier used by the classifier to determine which agent's bot identity
   * the event was addressed to. Provider-specific:
   *   - github: numeric App ID (string form) from installation.app_id
   *   - linear: agent UUID from the webhook's agent context (or 'unknown')
   *   - slack: bot user ID (Uxxxxx) from the app_mention / message event
   */
  agent_hint: string;
  /** The raw JSON payload, parsed. */
  payload: unknown;
  /** When the router received the delivery (ms epoch). */
  received_at: number;
  /** Optional — the actor's login for provider events (GitHub `sender.login`).
   *  Used to skip self-triggered webhooks (a bot's own comment fires an event
   *  that would re-trigger the same agent, causing a feedback loop). */
  sender_login?: string;
};

/**
 * The abstraction the ingress layer uses to look up the secret for a given
 * provider + agent hint. Phase 3 tests use a stub; Phase 4 wires in the real
 * identity loader from identities/*.yml.
 */
export type SecretLookup = (args: {
  provider: Provider;
  agent_hint: string;
}) => Promise<
  { found: true; agent: string; webhook_secret: string } | { found: false; reason: string }
>;
