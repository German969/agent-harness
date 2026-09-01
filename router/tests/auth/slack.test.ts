import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifySlackSignature } from '../../src/auth/slack.js';

function slackSign(body: string, ts: string, secret: string): string {
  const base = `v0:${ts}:${body}`;
  return `v0=${createHmac('sha256', secret).update(base).digest('hex')}`;
}

describe('verifySlackSignature', () => {
  const secret = 'slack-signing-secret';
  const body = Buffer.from('{"type":"app_mention"}');
  const now = 1700_000_000_000;
  const ts = String(Math.floor(now / 1000));

  it('accepts a valid signature within the 5-min window', () => {
    const headers = {
      'x-slack-signature': slackSign(body.toString(), ts, secret),
      'x-slack-request-timestamp': ts,
    };
    expect(verifySlackSignature(body, headers, secret, now)).toEqual({ ok: true });
  });

  it('rejects a signature older than 5 minutes (replay attack)', () => {
    const oldTs = String(Math.floor((now - 6 * 60 * 1000) / 1000));
    const headers = {
      'x-slack-signature': slackSign(body.toString(), oldTs, secret),
      'x-slack-request-timestamp': oldTs,
    };
    const result = verifySlackSignature(body, headers, secret, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('timestamp_too_old');
  });

  it('rejects a future timestamp beyond the window', () => {
    const futureTs = String(Math.floor((now + 6 * 60 * 1000) / 1000));
    const headers = {
      'x-slack-signature': slackSign(body.toString(), futureTs, secret),
      'x-slack-request-timestamp': futureTs,
    };
    const result = verifySlackSignature(body, headers, secret, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('timestamp_too_old');
  });

  it('rejects a tampered body', () => {
    const headers = {
      'x-slack-signature': slackSign(body.toString(), ts, secret),
      'x-slack-request-timestamp': ts,
    };
    const tampered = Buffer.from('{"type":"different"}');
    const result = verifySlackSignature(tampered, headers, secret, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('signature_mismatch');
  });

  it('rejects missing headers', () => {
    expect(verifySlackSignature(body, {}, secret, now).ok).toBe(false);
    expect(verifySlackSignature(body, { 'x-slack-signature': 'v0=00' }, secret, now).ok).toBe(
      false,
    );
    expect(verifySlackSignature(body, { 'x-slack-request-timestamp': ts }, secret, now).ok).toBe(
      false,
    );
  });

  it('rejects invalid timestamp', () => {
    const headers = {
      'x-slack-signature': 'v0=abcdef',
      'x-slack-request-timestamp': 'not-a-number',
    };
    const result = verifySlackSignature(body, headers, secret, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_timestamp');
  });

  it('rejects wrong signature prefix', () => {
    const headers = {
      'x-slack-signature': `v1=${'a'.repeat(64)}`,
      'x-slack-request-timestamp': ts,
    };
    const result = verifySlackSignature(body, headers, secret, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_signature_prefix');
  });
});
