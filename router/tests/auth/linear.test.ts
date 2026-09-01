import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyLinearSignature } from '../../src/auth/linear.js';

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

describe('verifyLinearSignature', () => {
  const secret = 'linear-secret';
  const body = Buffer.from('{"type":"Issue","action":"create"}');

  it('accepts a valid signature (no prefix, raw hex)', () => {
    const headers = { 'linear-signature': sign(body.toString(), secret) };
    expect(verifyLinearSignature(body, headers, secret)).toEqual({ ok: true });
  });

  it('rejects a tampered body', () => {
    const headers = { 'linear-signature': sign(body.toString(), secret) };
    const tampered = Buffer.from('{"type":"Issue","action":"delete"}');
    const result = verifyLinearSignature(tampered, headers, secret);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('signature_mismatch');
  });

  it('rejects missing header', () => {
    const result = verifyLinearSignature(body, {}, secret);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing_signature_header');
  });

  it('rejects malformed hex', () => {
    const headers = { 'linear-signature': 'not-hex-string' };
    const result = verifyLinearSignature(body, headers, secret);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed_signature_hex');
  });

  it('rejects wrong secret', () => {
    const headers = { 'linear-signature': sign(body.toString(), 'wrong-secret') };
    const result = verifyLinearSignature(body, headers, secret);
    expect(result.ok).toBe(false);
  });

  describe('mismatch diagnostics', () => {
    it('names the repair when the stored secret only has stray whitespace', () => {
      const headers = { 'linear-signature': sign(body.toString(), secret) };
      const result = verifyLinearSignature(body, headers, `${secret}\n`);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('signature_mismatch');
      expect(result.diagnostics?.secret_padded).toBe(true);
      expect(result.diagnostics?.verifies_after).toBe('trim');
    });

    it('names the repair when the stored secret was pasted with its quotes', () => {
      const headers = { 'linear-signature': sign(body.toString(), secret) };
      const result = verifyLinearSignature(body, headers, `"${secret}"`);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics?.secret_padded).toBe(false);
      expect(result.diagnostics?.verifies_after).toBe('unquote');
    });

    it('reports no repair when the value is simply the wrong secret', () => {
      const headers = { 'linear-signature': sign(body.toString(), 'wrong-secret') };
      const result = verifyLinearSignature(body, headers, secret);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics?.verifies_after).toBeNull();
      expect(result.diagnostics?.body_length).toBe(body.length);
    });

    it('fingerprints the resolved value without exposing it', () => {
      const headers = { 'linear-signature': sign(body.toString(), 'wrong-secret') };
      const result = verifyLinearSignature(body, headers, secret);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const fingerprint = result.diagnostics?.secret_fingerprint ?? '';
      expect(fingerprint).toBe(
        createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 8),
      );
      // A fingerprint is only useful if it cannot be walked back to the secret:
      // 8 hex characters is a truncation, not an encoding.
      expect(fingerprint).toHaveLength(8);
      expect(JSON.stringify(result.diagnostics)).not.toContain(secret);
    });

    it('carries no diagnostics when the header never got as far as a digest', () => {
      const result = verifyLinearSignature(body, {}, secret);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics).toBeUndefined();
    });
  });
});
