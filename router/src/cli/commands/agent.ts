// `dev-team-logs agent <name> [--since 1h] [--status running|completed|...]` —
// list sessions for one agent within a time window.

import type { Db } from '../../state/db.js';
import type { SessionRow } from '../../state/sessions.js';
import { type ParsedArgs, getStringFlag } from '../argv.js';
import { fmtTs, fmtUsd, parseDuration, table } from '../format.js';

export function agentCmd(db: Db, args: ParsedArgs): string {
  const name = args.positional[0];
  if (!name) return 'usage: agent <name> [--since 1h] [--status <s>]\n';

  const sinceFlag = getStringFlag(args, 'since');
  const statusFlag = getStringFlag(args, 'status');

  let sinceMs = 0;
  if (sinceFlag) {
    try {
      sinceMs = Date.now() - parseDuration(sinceFlag);
    } catch (err) {
      return `error: ${(err as Error).message}\n`;
    }
  }

  const where: string[] = ['agent = ?'];
  const params: (string | number)[] = [name];
  if (sinceMs > 0) {
    where.push('started_at >= ?');
    params.push(sinceMs);
  }
  if (statusFlag) {
    where.push('status = ?');
    params.push(statusFlag);
  }

  const rows = db
    .prepare(
      `SELECT * FROM sessions WHERE ${where.join(' AND ')} ORDER BY started_at DESC LIMIT 100`,
    )
    .all(...params) as SessionRow[];

  if (rows.length === 0) return `(no sessions for agent=${name})\n`;

  const formatted = rows.map((r) => ({
    id: r.id,
    status: r.status,
    started: fmtTs(r.started_at),
    turns: r.turns,
    cost: fmtUsd(r.cost_usd),
    skill: r.skill ?? '—',
    thread: r.thread_key.length > 40 ? `${r.thread_key.slice(0, 39)}…` : r.thread_key,
  }));

  return `${table(formatted)}\n`;
}
