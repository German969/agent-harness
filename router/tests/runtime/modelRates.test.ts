import { describe, expect, it } from 'vitest';
import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  estimateCost,
  isPricedModel,
  normalizeModelId,
  rateFor,
} from '../../src/runtime/modelRates.js';

describe('rateFor', () => {
  it('prices the models this fleet actually runs', () => {
    expect(rateFor('claude-sonnet-5')).toEqual({ inputPerMTok: 2, outputPerMTok: 10 });
    expect(rateFor('claude-opus-5')).toEqual({ inputPerMTok: 5, outputPerMTok: 25 });
    expect(rateFor('claude-haiku-4-5')).toEqual({ inputPerMTok: 1, outputPerMTok: 5 });
  });

  // The defect this replaces: a `startsWith('claude-sonnet')` bucket priced
  // Sonnet 5 at Sonnet 4.6's rates. They differ by 50%, so one was always wrong.
  it('distinguishes Sonnet 5 from Sonnet 4.6', () => {
    expect(rateFor('claude-sonnet-5').inputPerMTok).toBe(2);
    expect(rateFor('claude-sonnet-4-6').inputPerMTok).toBe(3);
  });

  // Agents pin real snapshot IDs; without suffix stripping every one of them
  // would miss the table and silently take the fallback.
  it('prices a date-pinned snapshot as its family', () => {
    expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(rateFor('claude-haiku-4-5-20251001')).toEqual(rateFor('claude-haiku-4-5'));
    expect(isPricedModel('claude-haiku-4-5-20251001')).toBe(true);
  });
});

describe('unknown models', () => {
  it('charge the most expensive known rate, never a mid-tier guess', () => {
    const unknown = rateFor('claude-something-unreleased');
    for (const known of ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5']) {
      expect(unknown.inputPerMTok).toBeGreaterThanOrEqual(rateFor(known).inputPerMTok);
      expect(unknown.outputPerMTok).toBeGreaterThanOrEqual(rateFor(known).outputPerMTok);
    }
    expect(isPricedModel('claude-something-unreleased')).toBe(false);
  });

  // A cap is a safety device: estimating an unpriced model low would let it run
  // to the turn limit at whatever it really costs, with the cap never firing.
  it('never estimate below what a known model would cost', () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    const unknown = estimateCost('claude-something-unreleased', usage);
    expect(unknown).toBeGreaterThanOrEqual(estimateCost('claude-opus-5', usage));
  });
});

describe('estimateCost', () => {
  it('bills all four token classes at their own rate', () => {
    // Sonnet 5: $2 input, $10 output, cache write 1.25x, cache read 0.1x.
    // 1M each = 2 + 2.50 + 0.20 + 10 = $14.70
    expect(
      estimateCost('claude-sonnet-5', {
        input_tokens: 1_000_000,
        cache_creation_input_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      }),
    ).toBeCloseTo(14.7, 10);
  });

  it('derives cache rates from the input rate', () => {
    const rate = rateFor('claude-opus-5');
    expect(estimateCost('claude-opus-5', { cache_creation_input_tokens: 1_000_000 })).toBeCloseTo(
      rate.inputPerMTok * CACHE_WRITE_MULTIPLIER,
      10,
    );
    expect(estimateCost('claude-opus-5', { cache_read_input_tokens: 1_000_000 })).toBeCloseTo(
      rate.inputPerMTok * CACHE_READ_MULTIPLIER,
      10,
    );
  });

  // Session 277 (IRS-46, the first PR the fleet ever shipped) as a fixture. The
  // old table reported $7.8499 for exactly these tokens against an $8 cap, so
  // the cap was really ~$5.30 and cut sessions off with budget to spare.
  it('reprices the session that exposed the stale table', () => {
    const session277 = {
      input_tokens: 16_595,
      output_tokens: 932,
      cache_creation_input_tokens: 373_683,
      cache_read_input_tokens: 21_282_751,
    };
    expect(estimateCost('claude-sonnet-5', session277)).toBeCloseTo(5.233, 3);
    // Opus 5 is exactly 2.5x Sonnet 5 on every axis, cache multipliers included.
    expect(estimateCost('claude-opus-5', session277)).toBeCloseTo(5.233 * 2.5, 2);
  });

  it('is zero for a missing usage record rather than throwing', () => {
    expect(estimateCost('claude-sonnet-5', undefined)).toBe(0);
    expect(estimateCost('claude-sonnet-5', {})).toBe(0);
  });
});
