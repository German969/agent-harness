// Linear webhook payload normalizer.

import type { WebhookEvent } from '../types.js';

/**
 * Linear webhooks carry:
 *   - `webhookId` — identifies the WEBHOOK, stable across every delivery it makes
 *   - `webhookTimestamp` — ms epoch, per delivery
 *   - `type` (Issue / Comment / IssueLabel / …) and `action` (create / update / remove)
 *   - the entity data in `data`
 *
 * `webhookId` is the `agent_hint`: ingress resolves it against
 * `identities/<agent>.yml → linear.webhook_id` to find the signing secret to verify
 * with. It must NOT also be the `delivery_id` — that is the primary half of the
 * `webhook_deliveries` idempotency key, so reusing a value that is stable per webhook
 * makes every delivery after the first collide and be dropped as a duplicate. The
 * surface would work exactly once.
 *
 * The delivery id therefore comes from Linear's per-delivery `Linear-Delivery` header,
 * falling back to a composite of the fields that vary per delivery when the header is
 * absent. The fallback is deliberate: a missing header must not silently reintroduce
 * a stable id, which fails closed-but-invisible (everything deduped, nothing routed).
 */
export function normalizeLinear(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  receivedAt: number = Date.now(),
): WebhookEvent {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new Error('body_not_json');
  }

  if (typeof payload !== 'object' || payload === null) {
    throw new Error('payload_not_object');
  }
  const p = payload as {
    webhookId?: unknown;
    webhookTimestamp?: unknown;
    type?: unknown;
    action?: unknown;
    data?: unknown;
    organizationId?: unknown;
  };

  const webhookId = typeof p.webhookId === 'string' ? p.webhookId : undefined;
  if (!webhookId) throw new Error('missing_webhookId');

  const kind = typeof p.type === 'string' ? p.type : 'unknown';
  const action = typeof p.action === 'string' ? p.action : 'unknown';

  return {
    provider: 'linear',
    delivery_id: deliveryId(headers, webhookId, kind, action, p.webhookTimestamp, p.data),
    event_type: `${kind}.${action}`,
    // Which agent's webhook secret verifies this delivery. Routing to the agent that
    // should HANDLE it is the classifier's job (mention → assignee → label).
    agent_hint: webhookId,
    payload,
    received_at: receivedAt,
  };
}

/** Per-delivery unique id: the Linear-Delivery header, else a composite. */
function deliveryId(
  headers: Record<string, string | string[] | undefined>,
  webhookId: string,
  kind: string,
  action: string,
  webhookTimestamp: unknown,
  data: unknown,
): string {
  const header = pick(headers['linear-delivery']);
  if (header) return header;

  // No header — build one from what varies per delivery. `webhookTimestamp` alone is
  // enough in practice; the entity id and action are included so two events emitted in
  // the same millisecond (a bulk label update, say) still differ.
  const stamp =
    typeof webhookTimestamp === 'number' || typeof webhookTimestamp === 'string'
      ? String(webhookTimestamp)
      : 'no-ts';
  const entityId =
    typeof data === 'object' && data !== null && 'id' in data
      ? String((data as { id: unknown }).id)
      : 'no-id';

  return `${webhookId}:${stamp}:${kind}.${action}:${entityId}`;
}

function pick(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}
