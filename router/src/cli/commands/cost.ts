// `dev-team-logs cost --month YYYY-MM` — cost breakdown for a month.

import type { DailyRollup } from '../../state/cost.js';
import { listMonthlyRollup } from '../../state/cost.js';
import type { Db } from '../../state/db.js';
import { type ParsedArgs, getStringFlag } from '../argv.js';
import { fmtUsd, parseYearMonth, table } from '../format.js';

const AGENTS = [
  'strategist',
  'platform',
  'builder-server',
  'builder-client',
  'guardian',
  'marketer',
  'harness',
] as const;

export function costCmd(db: Db, args: ParsedArgs): string {
  const monthFlag = getStringFlag(args, 'month');
  if (!monthFlag) return 'usage: cost --month YYYY-MM\n';

  let ym: { year: number; month: number };
  try {
    ym = parseYearMonth(monthFlag);
  } catch (err) {
    return `error: ${(err as Error).message}\n`;
  }

  const rows: Array<{
    agent: string;
    cost: string;
    input: number;
    output: number;
    sessions: number;
  }> = [];
  let totalUsd = 0;

  for (const agent of AGENTS) {
    const daily: DailyRollup[] = listMonthlyRollup(db, agent, ym.year, ym.month);
    if (daily.length === 0) continue;
    const cost = daily.reduce((s, d) => s + d.cost_usd, 0);
    const input = daily.reduce((s, d) => s + d.input_tokens, 0);
    const output = daily.reduce((s, d) => s + d.output_tokens, 0);
    const sessions = daily.reduce((s, d) => s + d.sessions_count, 0);
    totalUsd += cost;
    rows.push({ agent, cost: fmtUsd(cost), input, output, sessions });
  }

  if (rows.length === 0) return `(no cost data for ${monthFlag})\n`;

  return `Cost breakdown — ${monthFlag}\n\n${table(rows)}\n\nMonth total: ${fmtUsd(totalUsd)}\n`;
}
