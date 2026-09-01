// Assert that pino's redact config actually scrubs secret values from log output.
// The primary defense is "never log values" but this test verifies the defense-in-depth
// redact filter works if some future code accidentally logs an env-var block.

import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { pinoRedact } from '../../src/secrets/index.js';

function makeCapturingLogger() {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const logger = pino({ redact: pinoRedact }, sink);
  return { logger, chunks };
}

describe('pino redact', () => {
  it('scrubs the entire env block (safer default — no per-field bleed)', () => {
    const { logger, chunks } = makeCapturingLogger();
    logger.info({ env: { LINEAR_TOKEN: 'lin-secret-abc', SLACK_TEAM_ID: 'T012' } }, 'session prep');
    const combined = chunks.join('');
    // Both the secret AND the "public" ID get scrubbed. Public IDs should be logged
    // outside the env block if they need to be visible. This is deliberate — no risk of
    // partial-scrub bleeding secrets through an incomplete redact path list.
    expect(combined).not.toContain('lin-secret-abc');
    expect(combined).not.toContain('T012');
    expect(combined).toContain('[REDACTED]');
  });

  it('scrubs top-level env.* block', () => {
    const { logger, chunks } = makeCapturingLogger();
    logger.info({ env: { GITHUB_APP_PRIVATE_KEY: 'gh-priv-xyz' } }, 'test');
    const combined = chunks.join('');
    expect(combined).not.toContain('gh-priv-xyz');
  });

  it('scrubs nested secrets block', () => {
    const { logger, chunks } = makeCapturingLogger();
    logger.info({ secrets: { ANTHROPIC_API_KEY: 'sk-super-secret-abc' } }, 'test');
    const combined = chunks.join('');
    expect(combined).not.toContain('sk-super-secret-abc');
  });

  it('scrubs common secret patterns (token/apiKey/privateKey)', () => {
    const { logger, chunks } = makeCapturingLogger();
    logger.info({ obj: { token: 'token-abc', apiKey: 'ak-def', privateKey: 'pk-ghi' } }, 'generic');
    const combined = chunks.join('');
    expect(combined).not.toContain('token-abc');
    expect(combined).not.toContain('ak-def');
    expect(combined).not.toContain('pk-ghi');
  });
});
