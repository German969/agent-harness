// `dev-team-logs session <id>` — full trace for a session row.
//
// Prints:
//   - The session row (all fields)
//   - The parsed trigger_payload as pretty JSON
//   - Any linked schedule_runs entry (if the session came from a cron)
//
// --tail (follow) is deferred to Phase 10 — needs the jsonl session log.

import type { Db } from '../../state/db.js';
import { getSession } from '../../state/sessions.js';
import type { ParsedArgs } from '../argv.js';
import { fmtTs, fmtUsd } from '../format.js';

export function sessionCmd(db: Db, args: ParsedArgs): string {
  const id = args.positional[0];
  if (!id) return 'usage: session <id>\n';
  const numeric = Number.parseInt(id, 10);
  if (Number.isNaN(numeric)) return `error: session id must be numeric — got "${id}"\n`;

  const row = getSession(db, numeric);
  if (!row) return `session ${numeric} not found\n`;

  const lines: string[] = [
    `Session ${row.id}`,
    `  agent:              ${row.agent}`,
    `  skill:              ${row.skill ?? '—'}`,
    `  status:             ${row.status}`,
    `  thread_key:         ${row.thread_key}`,
    `  claude_session_id:  ${row.claude_session_id ?? '—'}`,
    `  triggered_by:       ${row.triggered_by}`,
    `  parent session:     ${row.triggered_by_session_id ?? '—'}`,
    `  started:            ${fmtTs(row.started_at)}`,
    `  ended:              ${fmtTs(row.ended_at)}`,
    `  turns:              ${row.turns}`,
    `  cost:               ${fmtUsd(row.cost_usd)}  (in=${row.cost_input_tokens} out=${row.cost_output_tokens})`,
    `  worktree:           ${row.worktree_path ?? '—'}`,
    `  error_kind:         ${row.error_kind ?? '—'}`,
    `  notes:              ${row.notes ?? '—'}`,
    '',
    'trigger_payload:',
  ];

  try {
    const parsed = JSON.parse(row.trigger_payload);
    lines.push(indent(JSON.stringify(parsed, null, 2), '  '));
  } catch {
    lines.push(`  ${row.trigger_payload}`);
  }

  // Linked schedule_run, if any.
  const scheduleRun = db
    .prepare('SELECT cron_id, fired_at, outcome FROM schedule_runs WHERE session_id = ? LIMIT 1')
    .get(numeric) as { cron_id: string; fired_at: number; outcome: string } | undefined;
  if (scheduleRun) {
    lines.push(
      '',
      'schedule_run:',
      `  cron_id:  ${scheduleRun.cron_id}`,
      `  fired_at: ${fmtTs(scheduleRun.fired_at)}`,
      `  outcome:  ${scheduleRun.outcome}`,
    );
  }

  return `${lines.join('\n')}\n`;
}

function indent(s: string, prefix: string): string {
  return s
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}
