// Slack events + slash-command payload normalizer.

import type { WebhookEvent } from '../types.js';

/**
 * Slack's Events API sends JSON payloads like:
 *   { token, team_id, api_app_id, event: { type, user, channel, text, ... }, event_id, event_time }
 *
 * The `api_app_id` uniquely identifies which Slack app (agent) sent this — we
 * use it as the `agent_hint`. The `event_id` is our deduplication key.
 *
 * URL-verification handshake events (`type: 'url_verification'`) are handled
 * separately at the route layer — they don't go through this normalizer.
 *
 * Slash commands (`/webhooks/slack/commands`) use a DIFFERENT (form-urlencoded)
 * shape and don't go through this normalizer either.
 */
export function normalizeSlackEvent(
  rawBody: Buffer,
  _headers: Record<string, string | string[] | undefined>,
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
    event_id?: unknown;
    api_app_id?: unknown;
    event?: unknown;
    type?: unknown;
  };

  const eventId = typeof p.event_id === 'string' ? p.event_id : undefined;
  if (!eventId) throw new Error('missing_event_id');

  const appId = typeof p.api_app_id === 'string' ? p.api_app_id : undefined;

  let eventType = 'unknown';
  if (typeof p.event === 'object' && p.event !== null && 'type' in p.event) {
    eventType = String((p.event as { type: unknown }).type);
  } else if (typeof p.type === 'string') {
    eventType = p.type;
  }

  return {
    provider: 'slack',
    delivery_id: eventId,
    event_type: eventType,
    agent_hint: appId ?? 'unknown',
    payload,
    received_at: receivedAt,
  };
}
