// Cost-cap threshold warning tests.

import pino from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryAlertPoster } from '../../src/observability/alerts.js';
import { checkCapWarnings } from '../../src/runtime/capWarnings.js';
import {
  type Db,
  applyMigrations,
  openDb,
  recordTurnCost,
  wasAlertEmitted,
} from '../../src/state/index.js';

const log = pino({ level: 'silent' });

function mkDb(): Db {
  const db = openDb({ path: ':memory:' });
  applyMigrations(db);
  return db;
}

describe('checkCapWarnings', () => {
  let db: Db;
  let poster: MemoryAlertPoster;
  beforeEach(() => {
    db = mkDb();
    poster = new MemoryAlertPoster();
  });

  it('does nothing below the warn threshold', async () => {
    // $50 spent against $100 cap — 50%, below 80% warn.
    recordTurnCost(db, 'strategist', { cost_usd: 50, input_tokens: 0, output_tokens: 0 });
    const r = await checkCapWarnings(
      db,
      {
        agent: 'strategist',
        monthlyCostUsd: 100,
        warnAtPercent: 80,
        alertChannel: '#agents-alerts',
      },
      poster,
      log,
    );
    expect(r.emitted).toEqual([]);
    expect(poster.messages).toEqual([]);
    expect(r.percentOfCap).toBeCloseTo(50, 1);
  });

  it('emits a warn at 80% crossing', async () => {
    // $85 spent → 85% of $100.
    recordTurnCost(db, 'strategist', { cost_usd: 85, input_tokens: 0, output_tokens: 0 });
    const r = await checkCapWarnings(
      db,
      {
        agent: 'strategist',
        monthlyCostUsd: 100,
        warnAtPercent: 80,
        alertChannel: '#agents-alerts',
      },
      poster,
      log,
    );
    expect(r.emitted).toEqual([80]);
    expect(poster.messages).toHaveLength(1);
    const msg = poster.messages[0];
    expect(msg?.level).toBe('warn');
    expect(msg?.channel).toBe('#agents-alerts');
    expect(msg?.title).toContain('80%');
    expect(msg?.fields?.month_to_date_usd).toBe('85.00');
  });

  it('is idempotent — a second call at the same level does not re-post', async () => {
    recordTurnCost(db, 'strategist', { cost_usd: 85, input_tokens: 0, output_tokens: 0 });
    await checkCapWarnings(
      db,
      { agent: 'strategist', monthlyCostUsd: 100, warnAtPercent: 80, alertChannel: '#a' },
      poster,
      log,
    );
    // Simulate another turn adding cost but not crossing 100%.
    recordTurnCost(db, 'strategist', { cost_usd: 5, input_tokens: 0, output_tokens: 0 });
    const r2 = await checkCapWarnings(
      db,
      { agent: 'strategist', monthlyCostUsd: 100, warnAtPercent: 80, alertChannel: '#a' },
      poster,
      log,
    );
    expect(r2.emitted).toEqual([]);
    expect(poster.messages).toHaveLength(1);
  });

  it('emits BOTH 80% and 100% in a single call when the jump crosses both', async () => {
    // Straight to $120 = 120% of $100 without any prior alert.
    recordTurnCost(db, 'strategist', { cost_usd: 120, input_tokens: 0, output_tokens: 0 });
    const r = await checkCapWarnings(
      db,
      { agent: 'strategist', monthlyCostUsd: 100, warnAtPercent: 80, alertChannel: '#a' },
      poster,
      log,
    );
    // Both levels emit — order is 100% first (severity), then 80%.
    expect([...r.emitted].sort((a, b) => a - b)).toEqual([80, 100]);
    expect(poster.messages).toHaveLength(2);
    const levels = poster.messages.map((m) => m.level).sort();
    expect(levels).toEqual(['error', 'warn']);
  });

  it('emits 100% alert on top of an earlier 80% alert without duplicating 80%', async () => {
    recordTurnCost(db, 'strategist', { cost_usd: 85, input_tokens: 0, output_tokens: 0 });
    await checkCapWarnings(
      db,
      { agent: 'strategist', monthlyCostUsd: 100, warnAtPercent: 80, alertChannel: '#a' },
      poster,
      log,
    );
    expect(poster.messages).toHaveLength(1);

    // Push to 105%.
    recordTurnCost(db, 'strategist', { cost_usd: 20, input_tokens: 0, output_tokens: 0 });
    const r2 = await checkCapWarnings(
      db,
      { agent: 'strategist', monthlyCostUsd: 100, warnAtPercent: 80, alertChannel: '#a' },
      poster,
      log,
    );
    expect(r2.emitted).toEqual([100]);
    expect(poster.messages).toHaveLength(2);
    expect(
      wasAlertEmitted(db, {
        agent: 'strategist',
        year: r2.emitted[0] ? new Date().getUTCFullYear() : 0,
        month: new Date().getUTCMonth() + 1,
        level: 100,
      }),
    ).toBe(true);
  });

  it('per-agent isolation — one agent hitting 80% does not silence the other', async () => {
    recordTurnCost(db, 'strategist', { cost_usd: 85, input_tokens: 0, output_tokens: 0 });
    recordTurnCost(db, 'marketer', { cost_usd: 85, input_tokens: 0, output_tokens: 0 });
    await checkCapWarnings(
      db,
      { agent: 'strategist', monthlyCostUsd: 100, warnAtPercent: 80, alertChannel: '#a' },
      poster,
      log,
    );
    await checkCapWarnings(
      db,
      { agent: 'marketer', monthlyCostUsd: 100, warnAtPercent: 80, alertChannel: '#a' },
      poster,
      log,
    );
    expect(poster.messages.map((m) => m.agent).sort()).toEqual(['marketer', 'strategist']);
  });

  it('percent computation handles zero monthly cap safely (no divide-by-zero)', async () => {
    recordTurnCost(db, 'strategist', { cost_usd: 10, input_tokens: 0, output_tokens: 0 });
    const r = await checkCapWarnings(
      db,
      { agent: 'strategist', monthlyCostUsd: 0, warnAtPercent: 80, alertChannel: '#a' },
      poster,
      log,
    );
    // 0% of a $0 cap — no alert fires (avoids nuisance-post storms if config is bad).
    expect(r.percentOfCap).toBe(0);
    expect(r.emitted).toEqual([]);
  });
});
