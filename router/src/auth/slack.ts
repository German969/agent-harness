// Slack request signature verification.
// Per https://api.slack.com/authentication/verifying-requests-from-slack
//
// Header 1: X-Slack-Signature: v0=<hex>
// Header 2: X-Slack-Request-Timestamp: <unix seconds>
// Computed: HMAC-SHA256(signing_secret, "v0:" + timestamp + ":" + raw_body).hex()
// Compare: constant-time
// Additional: reject if the timestamp is older than 5 minutes (replay protection).

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { VerifyResult } from './github.js';

const SIG_HEADER = 'x-slack-signature';
const TS_HEADER = 'x-slack-request-timestamp';
const PREFIX = 'v0=';
const MAX_TS_AGE_MS = 5 * 60 * 1000;

export function verifySlackSignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  signingSecret: string,
  now: number = Date.now(),
): VerifyResult {
  const sig = pickHeader(headers[SIG_HEADER]);
  const ts = pickHeader(headers[TS_HEADER]);
  if (!sig) return { ok: false, reason: 'missing_signature_header' };
  if (!ts) return { ok: false, reason: 'missing_timestamp_header' };
  if (!sig.startsWith(PREFIX)) return { ok: false, reason: 'invalid_signature_prefix' };

  const tsNum = Number.parseInt(ts, 10);
  if (!Number.isFinite(tsNum) || tsNum <= 0) return { ok: false, reason: 'invalid_timestamp' };

  // Replay protection — reject stale timestamps.
  const tsMs = tsNum * 1000;
  if (Math.abs(now - tsMs) > MAX_TS_AGE_MS) {
    return { ok: false, reason: 'timestamp_too_old' };
  }

  const provided = sig.slice(PREFIX.length);
  if (!/^[0-9a-f]{64}$/.test(provided)) {
    return { ok: false, reason: 'malformed_signature_hex' };
  }

  const base = `v0:${ts}:${rawBody.toString('utf8')}`;
  const expected = createHmac('sha256', signingSecret).update(base).digest('hex');

  const providedBuf = Buffer.from(provided, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (providedBuf.length !== expectedBuf.length) {
    return { ok: false, reason: 'length_mismatch' };
  }
  if (!timingSafeEqual(providedBuf, expectedBuf)) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  return { ok: true };
}

function pickHeader(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}
