// GitHub webhook payload normalizer.
// Extracts the fields the router cares about; leaves the rest in `payload`.

import type { WebhookEvent } from '../types.js';

export type GithubHeaders = {
  'x-github-delivery'?: string | string[] | undefined;
  'x-github-event'?: string | string[] | undefined;
  'x-github-hook-installation-target-id'?: string | string[] | undefined;
};

/**
 * Parse a GitHub webhook body + headers into a WebhookEvent.
 * Throws on missing required headers; callers should return 400 in that case.
 *
 * Note: this runs BEFORE signature verification (peeking at App ID to look up
 * the correct secret is safe — the payload can be forged but signature verify
 * will reject if it is).
 */
export function normalizeGithub(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  receivedAt: number = Date.now(),
): WebhookEvent {
  const deliveryId = pick(headers['x-github-delivery']);
  const eventName = pick(headers['x-github-event']);
  if (!deliveryId) throw new Error('missing_x_github_delivery');
  if (!eventName) throw new Error('missing_x_github_event');

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new Error('body_not_json');
  }

  // Sub-action for events like pull_request.opened
  const action =
    typeof payload === 'object' && payload !== null && 'action' in payload
      ? String((payload as { action: unknown }).action)
      : undefined;
  const eventType = action ? `${eventName}.${action}` : eventName;

  // Prefer installation.app_id (numeric) as the agent hint. Fall back to the
  // hook-installation-target-id header if the payload doesn't carry it.
  let appId: string | undefined;
  if (typeof payload === 'object' && payload !== null && 'installation' in payload) {
    const inst = (payload as { installation: unknown }).installation;
    if (typeof inst === 'object' && inst !== null && 'app_id' in inst) {
      appId = String((inst as { app_id: unknown }).app_id);
    }
  }
  if (!appId) {
    appId = pick(headers['x-github-hook-installation-target-id']);
  }

  // Extract sender info — used by the route to detect + skip events triggered
  // by our own bots (a Harness comment posts a webhook that would re-trigger
  // Harness, causing a feedback loop).
  const senderLogin = extractSenderLogin(payload);

  return {
    provider: 'github',
    delivery_id: deliveryId,
    event_type: eventType,
    agent_hint: appId ?? 'unknown',
    payload,
    received_at: receivedAt,
    ...(senderLogin ? { sender_login: senderLogin } : {}),
  };
}

function extractSenderLogin(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || !('sender' in payload)) {
    return undefined;
  }
  const s = (payload as { sender: unknown }).sender;
  if (typeof s !== 'object' || s === null || !('login' in s)) return undefined;
  const login = (s as { login: unknown }).login;
  return typeof login === 'string' ? login : undefined;
}

function pick(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}
