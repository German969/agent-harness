import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Db,
  applyMigrations,
  dayKey,
  getMonthlyAgentSpend,
  listMonthlyRollup,
  openDb,
  recordSessionStart,
  recordTurnCost,
} from '../../src/state/index.js';

describe('cost_ledger', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb({ path: ':memory:' });
    applyMigrations(db);
  });

  it('dayKey returns UTC components', () => {
    // 2026-06-15T13:00:00.000Z
    const k = dayKey(new Date('2026-06-15T13:00:00.000Z').getTime());
    expect(k).toEqual({ year: 2026, month: 6, day: 15 });
  });

  it('recordTurnCost upserts a daily rollup row', () => {
    const ts = new Date('2026-06-15T10:00:00Z').getTime();
    recordTurnCost(db, 'strategist', { cost_usd: 0.5, input_tokens: 100, output_tokens: 50 }, ts);
    recordTurnCost(db, 'strategist', { cost_usd: 0.25, input_tokens: 50, output_tokens: 25 }, ts);

    const rollups = listMonthlyRollup(db, 'strategist', 2026, 6);
    expect(rollups).toHaveLength(1);
    expect(rollups[0]?.cost_usd).toBeCloseTo(0.75);
    expect(rollups[0]?.input_tokens).toBe(150);
    expect(rollups[0]?.output_tokens).toBe(75);
  });

  it('recordSessionStart increments sessions_count', () => {
    const ts = new Date('2026-06-15T10:00:00Z').getTime();
    recordSessionStart(db, 'guardian', ts);
    recordSessionStart(db, 'guardian', ts);
    recordSessionStart(db, 'guardian', ts);

    const rollup = listMonthlyRollup(db, 'guardian', 2026, 6);
    expect(rollup[0]?.sessions_count).toBe(3);
  });

  it('getMonthlyAgentSpend sums across days', () => {
    const day1 = new Date('2026-06-01T10:00:00Z').getTime();
    const day15 = new Date('2026-06-15T10:00:00Z').getTime();
    const otherMonth = new Date('2026-07-01T10:00:00Z').getTime();

    recordTurnCost(db, 'marketer', { cost_usd: 1.0, input_tokens: 0, output_tokens: 0 }, day1);
    recordTurnCost(db, 'marketer', { cost_usd: 2.5, input_tokens: 0, output_tokens: 0 }, day15);
    recordTurnCost(
      db,
      'marketer',
      { cost_usd: 99.0, input_tokens: 0, output_tokens: 0 },
      otherMonth,
    );

    expect(getMonthlyAgentSpend(db, 'marketer', 2026, 6)).toBeCloseTo(3.5);
    expect(getMonthlyAgentSpend(db, 'marketer', 2026, 7)).toBeCloseTo(99.0);
  });

  it('listMonthlyRollup is ordered by day ascending', () => {
    const day1 = new Date('2026-06-01T10:00:00Z').getTime();
    const day5 = new Date('2026-06-05T10:00:00Z').getTime();
    const day3 = new Date('2026-06-03T10:00:00Z').getTime();

    recordTurnCost(db, 'platform', { cost_usd: 1, input_tokens: 0, output_tokens: 0 }, day5);
    recordTurnCost(db, 'platform', { cost_usd: 1, input_tokens: 0, output_tokens: 0 }, day1);
    recordTurnCost(db, 'platform', { cost_usd: 1, input_tokens: 0, output_tokens: 0 }, day3);

    const rollup = listMonthlyRollup(db, 'platform', 2026, 6);
    expect(rollup.map((r) => r.day)).toEqual([1, 3, 5]);
  });

  it('separate agents have separate rollups', () => {
    const ts = new Date('2026-06-15T10:00:00Z').getTime();
    recordTurnCost(db, 'strategist', { cost_usd: 1.0, input_tokens: 0, output_tokens: 0 }, ts);
    recordTurnCost(db, 'guardian', { cost_usd: 5.0, input_tokens: 0, output_tokens: 0 }, ts);

    expect(getMonthlyAgentSpend(db, 'strategist', 2026, 6)).toBeCloseTo(1.0);
    expect(getMonthlyAgentSpend(db, 'guardian', 2026, 6)).toBeCloseTo(5.0);
  });
});
