// `dev-team-logs trigger <thread-key>` — all sessions in a thread.

import type { Db } from '../../state/db.js';
import type { SessionRow } from '../../state/sessions.js';
import type { ParsedArgs } from '../argv.js';
import { fmtTs, fmtUsd, table } from '../format.js';

export function triggerCmd(db: Db, args: ParsedArgs): string {
  const key = args.positional[0];
  if (!key) return 'usage: trigger <thread-key>\n';

  const rows = db
    .prepare('SELECT * FROM sessions WHERE thread_key = ? ORDER BY started_at ASC')
    .all(key) as SessionRow[];

  if (rows.length === 0) return `(no sessions for thread=${key})\n`;

  const formatted = rows.map((r) => ({
    id: r.id,
    agent: r.agent,
    skill: r.skill ?? '—',
    status: r.status,
    started: fmtTs(r.started_at),
    turns: r.turns,
    cost: fmtUsd(r.cost_usd),
  }));

  const total = rows.reduce((s, r) => s + r.cost_usd, 0);
  return `Thread ${key} — ${rows.length} session(s) — total cost ${fmtUsd(total)}\n\n${table(formatted)}\n`;
}
