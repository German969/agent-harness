// Cost-cap threshold warnings — per ARCHITECTURE.md §2.7 alert rules.
//
// Algorithm (evaluated after every turn cost is persisted):
//   1. Compute month-to-date spend for the agent.
//   2. If cost is >= `warnAtPercent`% of `monthlyCostUsd` AND we haven't yet
//      emitted an 80%-level alert this month → post + record.
//   3. If cost is >= 100% AND we haven't yet emitted a 100%-level alert this
//      month → post + record.
//
// Levels are integer percentages so idempotency is table-simple: unique
// (agent, year, month, level).
//
// Cost tracking is monthly-bucketed at the schema layer (cost_ledger is per
// day + a per-month roll-up). There's no explicit "reset" cron — a new month
// naturally has no rows, so the query returns 0.

import type { Logger } from 'pino';
import type { AlertPoster } from '../observability/alerts.js';
import { dayKey, getMonthlyAgentSpend } from '../state/cost.js';
import { recordAlertEmitted, wasAlertEmitted } from '../state/cost_alerts.js';
import type { Db } from '../state/db.js';
import type { AgentId } from '../types.js';

export type CapWarningConfig = {
  agent: AgentId;
  monthlyCostUsd: number;
  warnAtPercent: number; // e.g. 80
  alertChannel: string; // e.g. `#agents-alerts`
};

export type CapWarningResult = {
  agent: AgentId;
  monthToDateUsd: number;
  percentOfCap: number;
  emitted: number[]; // levels emitted THIS call (usually 0 or 1 entry)
};

/**
 * Evaluate cost-cap thresholds against current spend + post one-shot warnings.
 * Safe to call after every turn (no-ops once alert is emitted).
 */
export async function checkCapWarnings(
  db: Db,
  cfg: CapWarningConfig,
  poster: AlertPoster,
  log: Logger,
  now?: number,
): Promise<CapWarningResult> {
  const k = dayKey(now);
  const monthToDate = getMonthlyAgentSpend(db, cfg.agent, k.year, k.month);
  const percentOfCap = cfg.monthlyCostUsd > 0 ? (monthToDate / cfg.monthlyCostUsd) * 100 : 0;

  const emitted: number[] = [];
  const key = { agent: cfg.agent, year: k.year, month: k.month };

  // 100% threshold — always evaluate before 80% so both can fire in a single
  // call when a session jumped over both bands at once.
  if (percentOfCap >= 100 && !wasAlertEmitted(db, { ...key, level: 100 })) {
    await poster.post({
      agent: cfg.agent,
      channel: cfg.alertChannel,
      level: 'error',
      title: `🛑 ${cfg.agent} monthly cost cap reached`,
      body: `Agent ${cfg.agent} has reached 100% of its monthly cost cap ($${cfg.monthlyCostUsd}). New sessions will be refused until the 1st.`,
      fields: {
        agent: cfg.agent,
        month_to_date_usd: monthToDate.toFixed(2),
        cap_usd: cfg.monthlyCostUsd,
        percent: percentOfCap.toFixed(1),
      },
    });
    recordAlertEmitted(db, { ...key, level: 100 }, monthToDate, now);
    emitted.push(100);
    log.warn(
      { agent: cfg.agent, monthToDate, cap: cfg.monthlyCostUsd },
      'cost cap 100% alert emitted',
    );
  }

  if (
    percentOfCap >= cfg.warnAtPercent &&
    !wasAlertEmitted(db, { ...key, level: cfg.warnAtPercent })
  ) {
    await poster.post({
      agent: cfg.agent,
      channel: cfg.alertChannel,
      level: 'warn',
      title: `⚠️ ${cfg.agent} monthly cost cap at ${cfg.warnAtPercent}%`,
      body: `Agent ${cfg.agent} has crossed ${cfg.warnAtPercent}% of its monthly cost cap ($${cfg.monthlyCostUsd}). Consider tightening scope for remaining sessions this month.`,
      fields: {
        agent: cfg.agent,
        month_to_date_usd: monthToDate.toFixed(2),
        cap_usd: cfg.monthlyCostUsd,
        percent: percentOfCap.toFixed(1),
      },
    });
    recordAlertEmitted(db, { ...key, level: cfg.warnAtPercent }, monthToDate, now);
    emitted.push(cfg.warnAtPercent);
    log.info(
      { agent: cfg.agent, monthToDate, cap: cfg.monthlyCostUsd, warnAtPercent: cfg.warnAtPercent },
      'cost cap warning threshold alert emitted',
    );
  }

  return { agent: cfg.agent, monthToDateUsd: monthToDate, percentOfCap, emitted };
}
