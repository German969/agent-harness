// "We cannot price this model" — the warning that makes an unpriced model visible.
//
// `rateFor` falls back to the most expensive row in the table when a model ID is
// not listed, deliberately: a cap has to fail toward refusing work rather than
// toward spending money it cannot see (see modelRates.ts). But that fallback is
// silent, and silence is the problem. An agent configured with a model the table
// does not know bills at Fable-5 rates against its cap — 5x Sonnet 5's real cost
// — so `refuse_session` fires at roughly a fifth of the work it was budgeted for.
// From the outside that looks exactly like the stale-rate bug PR #24 fixed, with
// a completely different cause.
//
// `isPricedModel` existed to detect this and had no callers anywhere, so nothing
// ever said it was happening. These two call sites are the fix: once per session
// (the guaranteed funnel, and the only place a skill's modelOverride is visible)
// and once at boot (so a mispriced agent shows up right after the deploy that
// introduced it, not at whatever hour it first happens to be triggered).
//
// A warning, not an error. The rate table is OUR data, not Anthropic's — a
// genuinely new model should not brick an agent until we get around to adding a
// row for it. Over-billing it against the cap is the safe direction; not knowing
// is what we are fixing.

import { loadAgentConfig } from '../config/agentLoader.js';
import type { AgentSettings } from '../config/settingsSchema.js';
import type { AgentId } from '../types.js';
import { isPricedModel, pricedModelIds } from './modelRates.js';

type WarnLogger = { warn: (obj: object, msg: string) => void };

/**
 * Warn when `model` is not in the rate table. `where` names what configured it
 * (an agent, or an agent's skill override) so the log line points at the file to
 * edit. No-op for a priced model, which is the overwhelmingly common case.
 */
export function warnIfUnpricedModel(
  model: string,
  log: WarnLogger,
  where: Record<string, unknown>,
): void {
  if (isPricedModel(model)) return;
  log.warn(
    { ...where, model, priced_models: pricedModelIds() },
    'model is not in the rate table — billing it at the most expensive known rate, so its cost cap will fire early. Add a row to runtime/modelRates.ts or correct the configured model ID.',
  );
}

/**
 * Boot-time sweep: check every agent's default model and every skill override.
 *
 * Best-effort by design. A config that fails to load is a separate problem with
 * its own reporting path, and a pricing audit must never be the thing that stops
 * the router from coming up — so a load failure is logged and skipped, not thrown.
 *
 * Returns the number of unpriced models found, so a caller (and a test) can
 * assert on the sweep rather than on log output.
 */
export function auditFleetModels(
  agents: readonly AgentId[],
  devTeamRoot: string,
  log: WarnLogger,
): number {
  let found = 0;
  for (const agent of agents) {
    let settings: AgentSettings;
    try {
      settings = loadAgentConfig(agent, { devTeamRoot }).settings;
    } catch (err) {
      log.warn(
        { agent, err: (err as Error).message },
        'model audit skipped for this agent — its config did not load',
      );
      continue;
    }
    if (!isPricedModel(settings.model)) {
      found++;
      warnIfUnpricedModel(settings.model, log, { agent, source: 'settings.model' });
    }
    for (const [skill, override] of Object.entries(settings.modelOverrides ?? {})) {
      // `modelOverrides` is a plain string map, so the `_comment` key every agent
      // uses to document its routing is indistinguishable from a skill name by
      // type. Reading it as a model made this audit warn on all seven agents at
      // boot — a false positive in the one place that exists to be believed.
      if (skill.startsWith('_')) continue;
      if (!isPricedModel(override)) {
        found++;
        warnIfUnpricedModel(override, log, { agent, skill, source: 'settings.modelOverrides' });
      }
    }
  }
  return found;
}
