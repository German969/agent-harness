import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyGithubSignature } from '../../src/auth/github.js';

function sign(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('verifyGithubSignature', () => {
  const secret = 'test-secret-abc';
  const body = Buffer.from('{"action":"opened","number":42}');

  it('accepts a valid signature', () => {
    const headers = { 'x-hub-signature-256': sign(body.toString(), secret) };
    expect(verifyGithubSignature(body, headers, secret)).toEqual({ ok: true });
  });

  it('rejects a tampered body', () => {
    const headers = { 'x-hub-signature-256': sign(body.toString(), secret) };
    const tampered = Buffer.from('{"action":"opened","number":43}');
    const result = verifyGithubSignature(tampered, headers, secret);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('signature_mismatch');
  });

  it('rejects a wrong secret', () => {
    const headers = { 'x-hub-signature-256': sign(body.toString(), 'other-secret') };
    const result = verifyGithubSignature(body, headers, secret);
    expect(result.ok).toBe(false);
  });

  it('rejects a missing signature header', () => {
    const result = verifyGithubSignature(body, {}, secret);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing_signature_header');
  });

  it('rejects a signature with wrong prefix', () => {
    const headers = { 'x-hub-signature-256': `sha1=${'0'.repeat(40)}` };
    const result = verifyGithubSignature(body, headers, secret);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_signature_prefix');
  });

  it('rejects malformed hex', () => {
    const headers = { 'x-hub-signature-256': 'sha256=not-hex' };
    const result = verifyGithubSignature(body, headers, secret);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed_signature_hex');
  });

  it('handles array-valued headers (takes first)', () => {
    const good = sign(body.toString(), secret);
    const headers = { 'x-hub-signature-256': [good, 'sha256=bad'] };
    expect(verifyGithubSignature(body, headers, secret)).toEqual({ ok: true });
  });
});
