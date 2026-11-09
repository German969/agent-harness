import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ScheduleFileError,
  loadSchedules,
  resetScheduleCache,
} from '../../src/scheduler/loader.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sched-loader-'));
  resetScheduleCache();
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function write(name: string, content: string): string {
  const p = join(tmp, name);
  writeFileSync(p, content, 'utf-8');
  return p;
}

describe('loadSchedules', () => {
  it('parses a minimal entry', () => {
    const p = write(
      'schedules.yml',
      `- id: test-1
  cron: "0 9 * * *"
  agent: strategist
  trigger:
    kind: scheduled
    message: hello
`,
    );
    const [e] = loadSchedules(p);
    expect(e?.id).toBe('test-1');
    expect(e?.timezone).toBe('UTC'); // default
    expect(e?.enabled).toBe(false); // default
    expect(e?.agent).toBe('strategist');
  });

  it('parses reply_to + timezone + phase gate', () => {
    const p = write(
      'schedules.yml',
      `- id: test-2
  cron: "0 14 * * FRI"
  timezone: America/New_York
  agent: marketer
  skill: growth-analyst
  trigger:
    kind: scheduled
    message: weekly digest
    reply_to:
      provider: slack
      channel: "#marketing"
  enabled: true
  requires_project_phase: phase-3
`,
    );
    const [e] = loadSchedules(p);
    expect(e?.enabled).toBe(true);
    expect(e?.requires_project_phase).toBe('phase-3');
    expect(e?.trigger.reply_to?.provider).toBe('slack');
    expect(e?.trigger.reply_to?.channel).toBe('#marketing');
    expect(e?.timezone).toBe('America/New_York');
  });

  it('rejects an unknown agent', () => {
    const p = write(
      'schedules.yml',
      `- id: bad
  cron: "0 9 * * *"
  agent: not-an-agent
  trigger:
    kind: scheduled
    message: x
`,
    );
    expect(() => loadSchedules(p)).toThrow(ScheduleFileError);
  });

  it('rejects duplicate ids', () => {
    const p = write(
      'schedules.yml',
      `- id: dup
  cron: "0 9 * * *"
  agent: strategist
  trigger:
    kind: scheduled
    message: x
- id: dup
  cron: "0 10 * * *"
  agent: strategist
  trigger:
    kind: scheduled
    message: y
`,
    );
    expect(() => loadSchedules(p)).toThrow(/duplicate id: dup/);
  });

  it('returns [] for an empty file', () => {
    const p = write('schedules.yml', '[]\n');
    expect(loadSchedules(p)).toEqual([]);
  });

  it('caches on mtime — a second load returns the same reference until file changes', () => {
    const p = write(
      'schedules.yml',
      `- id: t
  cron: "0 9 * * *"
  agent: strategist
  trigger:
    kind: scheduled
    message: m
`,
    );
    const a = loadSchedules(p);
    const b = loadSchedules(p);
    expect(a).toBe(b);
  });

  it('parses the real schedules.yml from dev-team/ without error', () => {
    // This repo's own schedules.yml, three levels up from router/tests/scheduler.
    const real = fileURLToPath(new URL('../../../scheduler/schedules.yml', import.meta.url));
    try {
      const entries = loadSchedules(real);
      expect(entries.length).toBeGreaterThan(5);
    } catch (err) {
      // If the file isn't available in this environment, skip.
      if ((err as Error).message.includes('ENOENT')) return;
      throw err;
    }
  });
});
