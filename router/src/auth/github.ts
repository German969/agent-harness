// GitHub App webhook signature verification.
// Per https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
//
// Header: X-Hub-Signature-256: sha256=<hex>
// Compute: HMAC-SHA256(webhook_secret, raw_body).hex()
// Compare: constant-time (timingSafeEqual)

import { createHmac, timingSafeEqual } from 'node:crypto';

const HEADER = 'x-hub-signature-256';
const PREFIX = 'sha256=';

/**
 * Non-secret detail about a signature mismatch, attached by a verifier that has
 * already ruled out a missing or malformed header. Populated for Linear today;
 * the shape is shared so GitHub and Slack can report the same way.
 */
export type SignatureMismatchDiagnostics = {
  /** First 8 hex of sha256(secret) — comparable against the value the secret
   *  store shows, without either side revealing it. */
  secret_fingerprint: string;
  secret_length: number;
  /** The stored value carries leading or trailing whitespace. */
  secret_padded: boolean;
  /** Name of the trivial repair that would have verified (e.g. 'trim'), or null
   *  when the value is simply the wrong secret. */
  verifies_after: string | null;
  body_length: number;
};

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: string; diagnostics?: SignatureMismatchDiagnostics };

export function verifyGithubSignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  webhookSecret: string,
): VerifyResult {
  const sigHeader = normalizeHeader(headers[HEADER]);
  if (!sigHeader) return { ok: false, reason: 'missing_signature_header' };
  if (!sigHeader.startsWith(PREFIX)) return { ok: false, reason: 'invalid_signature_prefix' };

  const provided = sigHeader.slice(PREFIX.length);
  if (!/^[0-9a-f]{64}$/.test(provided)) {
    return { ok: false, reason: 'malformed_signature_hex' };
  }

  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');

  // Both are 64-char hex strings; equal length guaranteed by the regex above.
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

function normalizeHeader(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}
