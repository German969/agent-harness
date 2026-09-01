import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { noopSessionLog, openSessionLog } from '../../src/observability/sessionLog.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sesslog-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('openSessionLog', () => {
  it('writes jsonl lines to <logDir>/<sessionId>.jsonl', () => {
    const w = openSessionLog({ logDir: dir, sessionId: 42 });
    w.write({ ts: '2026-06-15T00:00:00.000Z', event: 'session.started' });
    w.write({
      ts: '2026-06-15T00:00:01.000Z',
      event: 'turn.complete',
      data: { cost_usd: 0.01 },
    });
    const contents = readFileSync(w.path, 'utf-8').trim().split('\n');
    expect(contents).toHaveLength(2);
    const first = JSON.parse(contents[0] ?? '{}');
    expect(first.event).toBe('session.started');
    const second = JSON.parse(contents[1] ?? '{}');
    expect(second.data.cost_usd).toBe(0.01);
  });

  it('fills in ts when not provided', () => {
    const w = openSessionLog({ logDir: dir, sessionId: 7 });
    w.write({ ts: '', event: 'x' });
    const line = JSON.parse(readFileSync(w.path, 'utf-8').trim());
    expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('appends across multiple writes without truncating', () => {
    const w = openSessionLog({ logDir: dir, sessionId: 9 });
    for (let i = 0; i < 5; i++) w.write({ ts: '', event: `evt-${i}` });
    const lines = readFileSync(w.path, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(5);
  });

  it('creates the log directory if missing', () => {
    const nested = join(dir, 'nested', 'sessions');
    const w = openSessionLog({ logDir: nested, sessionId: 1 });
    w.write({ ts: '', event: 'x' });
    expect(readFileSync(w.path, 'utf-8')).toContain('x');
  });
});

describe('noopSessionLog', () => {
  it('accepts writes but produces no file', () => {
    const w = noopSessionLog(42);
    w.write({ ts: '', event: 'ignored' });
    expect(w.path).toBe('');
    expect(w.sessionId).toBe(42);
  });
});
