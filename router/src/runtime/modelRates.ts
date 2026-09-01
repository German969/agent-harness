// Per-model pricing, in USD per million tokens.
//
// This table is a hardcoded copy of Anthropic's public price list, and nothing
// detects when it drifts from the real one. It already had: the `sonnet` row
// carried Sonnet-4.6 prices ($3/$15) while every agent in this fleet runs
// Sonnet 5 ($2/$10), and the `opus` row carried Claude-3-era prices ($15/$75)
// against Opus 5's ($5/$25).
//
// Both over-reported — ~1.5x and 3x — and an over-report on a cost cap does not
// lose money, it loses WORK: the per-job cap cancels a session that still had
// real budget left, mid-implementation, with nothing to show. Session 277 was
// reported at $7.85 against an $8 cap while actually spending ~$5.23, so the
// configured cap was really a ~$5.30 one. That is also why switching an agent
// to Opus would have failed immediately: at the old row a session would have
// been cancelled at roughly a third of its intended budget.
//
// Two structural changes make the next drift smaller and cheaper:
//
//   - Keyed by MODEL ID, not by a family prefix. A prefix bucket cannot price
//     Sonnet 5 and Sonnet 4.6 differently, and they differ by 50%, so the old
//     `model.startsWith('claude-sonnet')` was guaranteed to be wrong for one of
//     them the moment both existed.
//   - Only input and output rates are listed. Cache write and cache read are
//     fixed multiples of the input rate, so deriving them removes two more
//     numbers per row that could rot on their own.
//
// Anthropic's console remains ground truth for billing; this estimator exists
// for cap enforcement and rough per-session spend visibility.

export type ModelRate = {
  inputPerMTok: number;
  outputPerMTok: number;
};

export type TokenUsage = {
  input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  output_tokens?: number | null;
};

/**
 * Cache pricing at the 5-minute TTL: a write costs 1.25x the input rate, a read
 * 0.1x. These are ratios of the input rate rather than absolute prices, so they
 * stay correct across every row and every future price change that keeps the
 * same structure.
 */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

/** USD per million tokens. Keys are model IDs with any date suffix stripped. */
const RATES: Record<string, ModelRate> = {
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
};

/**
 * An unpriced model is charged at the most expensive rate in the table.
 *
 * A cap is a safety device, so it has to fail toward refusing work rather than
 * toward spending money it cannot see: a model priced too low would run to the
 * turn limit at whatever it actually costs, and the cap — the one control that
 * is supposed to bound this — would never fire. The previous fallback was a
 * copy of the mid-tier row, which is the wrong direction for anything above it.
 *
 * Derived from the table rather than written down, so adding a pricier model
 * raises the floor automatically instead of leaving a stale constant behind.
 */
const FALLBACK_RATE: ModelRate = Object.values(RATES).reduce((worst, rate) => ({
  inputPerMTok: Math.max(worst.inputPerMTok, rate.inputPerMTok),
  outputPerMTok: Math.max(worst.outputPerMTok, rate.outputPerMTok),
}));

/**
 * Strip a trailing date suffix so a pinned snapshot prices as its family.
 * Agents pin real IDs (`claude-haiku-4-5-20251001`), and without this every one
 * of them would miss the table and silently take the fallback.
 */
export function normalizeModelId(model: string): string {
  return model.replace(/-\d{8}$/, '');
}

/** Rate for a model ID, falling back to the most expensive known rate. */
export function rateFor(model: string): ModelRate {
  return RATES[normalizeModelId(model)] ?? FALLBACK_RATE;
}

/** Whether the table prices this model, as opposed to falling back. */
export function isPricedModel(model: string): boolean {
  return normalizeModelId(model) in RATES;
}

/**
 * Every model ID the table prices, for the "you configured something we cannot
 * price" warning. Derived from the table so the message can never list a set the
 * code does not actually honour.
 */
export function pricedModelIds(): string[] {
  return Object.keys(RATES);
}

/**
 * Estimate one turn's cost in USD.
 *
 * Anthropic's usage record splits input across THREE fields — `input_tokens`
 * (uncached), `cache_creation_input_tokens` (write) and
 * `cache_read_input_tokens` (read) — and bills all three separately. Reading
 * only `input_tokens` (an earlier implementation) missed most of the bill: on a
 * long agent session cache reads dominate everything else, 81% of session 277.
 */
export function estimateCost(model: string, usage: TokenUsage | undefined): number {
  if (!usage) return 0;
  const rate = rateFor(model);
  const cacheWritePerMTok = rate.inputPerMTok * CACHE_WRITE_MULTIPLIER;
  const cacheReadPerMTok = rate.inputPerMTok * CACHE_READ_MULTIPLIER;
  return (
    ((usage.input_tokens ?? 0) / 1_000_000) * rate.inputPerMTok +
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) * cacheWritePerMTok +
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * cacheReadPerMTok +
    ((usage.output_tokens ?? 0) / 1_000_000) * rate.outputPerMTok
  );
}
