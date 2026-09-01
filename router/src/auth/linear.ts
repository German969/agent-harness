// Linear webhook signature verification.
// Per https://developers.linear.app/docs/graphql/webhooks — the signature is a
// raw hex HMAC-SHA256, no `sha256=` prefix. Header: Linear-Signature. Verified
// against Linear's own SDK (@linear/sdk, LinearWebhookClient.verify): it signs
// the raw request body alone — the `webhookTimestamp` field is a replay check,
// not part of the signed material.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { SignatureMismatchDiagnostics, VerifyResult } from './github.js';

const HEADER = 'linear-signature';

export function verifyLinearSignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  webhookSecret: string,
): VerifyResult {
  const raw = headers[HEADER];
  const provided = Array.isArray(raw) ? raw[0] : raw;
  if (!provided) return { ok: false, reason: 'missing_signature_header' };
  if (!/^[0-9a-f]{64}$/.test(provided)) {
    return { ok: false, reason: 'malformed_signature_hex' };
  }

  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const providedBuf = Buffer.from(provided, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (providedBuf.length !== expectedBuf.length) {
    return { ok: false, reason: 'length_mismatch' };
  }
  if (!timingSafeEqual(providedBuf, expectedBuf)) {
    return {
      ok: false,
      reason: 'signature_mismatch',
      diagnostics: describeMismatch(rawBody, providedBuf, webhookSecret),
    };
  }
  return { ok: true };
}

// Trivial repairs of a stored secret, tried only after a mismatch. Both are paste
// artifacts a secret store shows back to you as if nothing were wrong: a trailing
// newline picked up by a copy, or the surrounding quotes of a YAML/JSON snippet.
const REPAIRS: ReadonlyArray<{ name: string; apply: (s: string) => string }> = [
  { name: 'trim', apply: (s) => s.trim() },
  { name: 'unquote', apply: (s) => s.replace(/^(["'])([\s\S]*)\1$/, '$2') },
];

/**
 * Non-secret facts about a mismatch, gathered only once the header has been shown
 * to be present and well-formed — i.e. once the secret is the last suspect left.
 * A mismatch is otherwise undiagnosable without printing the secret, which we
 * will not do, so this reports what an operator needs and nothing more.
 */
function describeMismatch(
  rawBody: Buffer,
  providedBuf: Buffer,
  secret: string,
): SignatureMismatchDiagnostics {
  let verifiesAfter: string | null = null;
  for (const repair of REPAIRS) {
    const candidate = repair.apply(secret);
    if (candidate === secret) continue;
    const digest = createHmac('sha256', candidate).update(rawBody).digest('hex');
    if (timingSafeEqual(Buffer.from(digest, 'hex'), providedBuf)) {
      verifiesAfter = repair.name;
      break;
    }
  }

  return {
    // Truncated SHA-256 of the resolved value. An operator can run the same
    // digest over what their provider shows and compare: neither side reveals
    // the secret, and 8 hex of a SHA-256 over a high-entropy secret is not
    // invertible. This is the check that separates "wrong value" from
    // "right value, wrong bytes".
    secret_fingerprint: createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 8),
    secret_length: secret.length,
    secret_padded: secret.trim() !== secret,
    // Which repair would have verified, if any. Verification itself stays strict:
    // silently trimming a stored secret hides the misconfiguration rather than
    // fixing it, and leaves the next rotation to fail the same way.
    verifies_after: verifiesAfter,
    body_length: rawBody.length,
  };
}
