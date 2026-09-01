// Boot-race hardening: loadIdentitiesWaiting polls until the config volume populates.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadIdentitiesWaiting } from '../../src/server.js';

const log = pino({ level: 'silent' });
const IDENTITY = `agent: strategist
github:
  app_slug: "s-bot"
  bot_username: "s-bot"
linear:
  agent_handle: "s"
`;

let tmp: string;
let idDir: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'idwait-'));
  idDir = join(tmp, 'identities');
  mkdirSync(idDir, { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('loadIdentitiesWaiting', () => {
  it('returns immediately when identities are already present', async () => {
    writeFileSync(join(idDir, 'strategist.yml'), IDENTITY, 'utf-8');
    const start = Date.now();
    const r = await loadIdentitiesWaiting(idDir, log, 60_000, 2_000);
    expect(r.identities.length).toBe(1);
    // Did not sleep a poll interval — first read succeeded.
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('does not hang when maxWaitMs is 0 and the dir is empty', async () => {
    const r = await loadIdentitiesWaiting(idDir, log, 0, 2_000);
    expect(r.identities.length).toBe(0);
  });

  it('waits, then returns once the volume is populated', async () => {
    // Populate the identities dir shortly after the wait begins.
    setTimeout(() => writeFileSync(join(idDir, 'strategist.yml'), IDENTITY, 'utf-8'), 30);
    const r = await loadIdentitiesWaiting(idDir, log, 2_000, 10);
    expect(r.identities.length).toBe(1);
  });
});
