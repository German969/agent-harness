// `dev-team-logs schedule <subcmd>` — schedule inspection + override control.
//
// Subcommands:
//   list [--agent X] [--disabled]  — table of entries + effective state
//   enable <id> [--reason "..."]   — set override enabled
//   disable <id> [--reason "..."]  — set override disabled
//   reset <id> [--reason "..."]    — clear override (revert to YAML)
//   run <id>                       — fireOnce (bypasses cron)
//   history <id>                   — audit trail

import pino from 'pino';
import { resolveAll, resolveEffective } from '../../scheduler/effective.js';
import { loadSchedules } from '../../scheduler/loader.js';
import { fireOnce } from '../../scheduler/runner.js';
import type { ScheduleEntry } from '../../scheduler/schema.js';
import type { Db } from '../../state/db.js';
import { clearOverride, lastRunForCron, listHistory, setOverride } from '../../state/schedule.js';
import { type ParsedArgs, getStringFlag, hasFlag } from '../argv.js';
import { fmtTs, table } from '../format.js';

export type ScheduleCmdOptions = {
  db: Db;
  schedulesPath: string;
  targetProjectRoot?: string | undefined;
  actor: string; // for `set_by` on overrides
};

export async function scheduleCmd(args: ParsedArgs, opts: ScheduleCmdOptions): Promise<string> {
  const sub = args.positional[0];
  if (!sub) return scheduleUsage();

  let entries: ScheduleEntry[];
  try {
    entries = loadSchedules(opts.schedulesPath);
  } catch (err) {
    return `error loading schedules: ${(err as Error).message}\n`;
  }

  switch (sub) {
    case 'list':
      return listSubcmd(entries, args, opts);
    case 'enable':
      return enableSubcmd(entries, args, opts, true);
    case 'disable':
      return enableSubcmd(entries, args, opts, false);
    case 'reset':
      return resetSubcmd(entries, args, opts);
    case 'run':
      return runSubcmd(entries, args, opts);
    case 'history':
      return historySubcmd(entries, args, opts);
    default:
      return `unknown subcommand: ${sub}\n${scheduleUsage()}`;
  }
}

function scheduleUsage(): string {
  return (
    'usage: schedule <list|enable|disable|reset|run|history> [args]\n' +
    '\n' +
    '  list [--agent X] [--disabled]      table of entries + effective state\n' +
    '  enable <id> [--reason "..."]        set override enabled\n' +
    '  disable <id> [--reason "..."]       set override disabled\n' +
    '  reset <id> [--reason "..."]         clear override (revert to YAML)\n' +
    '  run <id>                            fire once, bypassing cron\n' +
    '  history <id>                        override audit trail\n'
  );
}

function findEntry(entries: ScheduleEntry[], id: string | undefined): ScheduleEntry | undefined {
  if (!id) return undefined;
  return entries.find((e) => e.id === id);
}

// ----------------------------------------------------------------------------
// list
// ----------------------------------------------------------------------------
function listSubcmd(entries: ScheduleEntry[], args: ParsedArgs, opts: ScheduleCmdOptions): string {
  const agentFilter = getStringFlag(args, 'agent');
  const disabledOnly = hasFlag(args, 'disabled');

  const resolved = resolveAll(entries, {
    db: opts.db,
    ...(opts.targetProjectRoot ? { targetProjectRoot: opts.targetProjectRoot } : {}),
  });

  const filtered = resolved.filter((r) => {
    if (agentFilter && r.entry.agent !== agentFilter) return false;
    if (disabledOnly && r.state !== 'disabled') return false;
    return true;
  });

  if (filtered.length === 0) return '(no matching schedules)\n';

  const rows = filtered.map((r) => {
    const last = lastRunForCron(opts.db, r.entry.id);
    return {
      id: r.entry.id,
      agent: r.entry.agent,
      cron: r.entry.cron,
      state: r.state,
      source: r.source,
      last_run: last ? fmtTs(last.fired_at) : '—',
      last_outcome: last?.outcome ?? '—',
    };
  });
  return `${table(rows)}\n`;
}

// ----------------------------------------------------------------------------
// enable / disable
// ----------------------------------------------------------------------------
function enableSubcmd(
  entries: ScheduleEntry[],
  args: ParsedArgs,
  opts: ScheduleCmdOptions,
  enabled: boolean,
): string {
  const id = args.positional[1];
  const entry = findEntry(entries, id);
  if (!entry) return `unknown schedule id: ${id}\n`;

  const reason = getStringFlag(args, 'reason');
  setOverride(opts.db, {
    cron_id: entry.id,
    enabled,
    set_by: opts.actor,
    ...(reason ? { reason } : {}),
  });

  const state = resolveEffective(entry, {
    db: opts.db,
    ...(opts.targetProjectRoot ? { targetProjectRoot: opts.targetProjectRoot } : {}),
  });
  return `${enabled ? 'enabled' : 'disabled'} ${entry.id} (effective: ${state.state}${state.reason ? ` — ${state.reason}` : ''})\n`;
}

// ----------------------------------------------------------------------------
// reset
// ----------------------------------------------------------------------------
function resetSubcmd(entries: ScheduleEntry[], args: ParsedArgs, opts: ScheduleCmdOptions): string {
  const id = args.positional[1];
  const entry = findEntry(entries, id);
  if (!entry) return `unknown schedule id: ${id}\n`;

  const reason = getStringFlag(args, 'reason');
  clearOverride(opts.db, entry.id, opts.actor, reason ?? 'reset to YAML default');

  const state = resolveEffective(entry, {
    db: opts.db,
    ...(opts.targetProjectRoot ? { targetProjectRoot: opts.targetProjectRoot } : {}),
  });
  return `reset ${entry.id} (effective: ${state.state}${state.reason ? ` — ${state.reason}` : ''})\n`;
}

// ----------------------------------------------------------------------------
// run
// ----------------------------------------------------------------------------
async function runSubcmd(
  entries: ScheduleEntry[],
  args: ParsedArgs,
  opts: ScheduleCmdOptions,
): Promise<string> {
  const id = args.positional[1];
  const entry = findEntry(entries, id);
  if (!entry) return `unknown schedule id: ${id}\n`;

  // The CLI's fireOnce doesn't have runtime access to the runner's onTick
  // callback — it just synthesizes the trigger + records the schedule_run.
  // Actual session dispatch happens when the router process picks up the
  // synthesized trigger; the CLI records the intent + returns.
  const outcome = await fireOnce(entry, {
    db: opts.db,
    log: pino({ level: 'silent' }),
    ...(opts.targetProjectRoot ? { targetProjectRoot: opts.targetProjectRoot } : {}),
    onTick: async () => {
      // CLI-side: we don't invoke runSession directly (no SdkClient, no
      // secretProvider, etc. wired). The tick synthesizes the trigger,
      // records `started`, and returns. The router process picks it up on
      // its next event-queue poll — Phase 12 wires this bridge.
    },
  });
  return `fireOnce ${entry.id} → ${outcome}\n`;
}

// ----------------------------------------------------------------------------
// history
// ----------------------------------------------------------------------------
function historySubcmd(
  entries: ScheduleEntry[],
  args: ParsedArgs,
  opts: ScheduleCmdOptions,
): string {
  const id = args.positional[1];
  const entry = findEntry(entries, id);
  if (!entry) return `unknown schedule id: ${id}\n`;

  const rows = listHistory(opts.db, entry.id);
  if (rows.length === 0) return `(no override history for ${entry.id})\n`;

  const formatted = rows.map((r) => ({
    at: fmtTs(r.set_at),
    action: r.enabled === -1 ? 'reset' : r.enabled === 1 ? 'enable' : 'disable',
    by: r.set_by,
    reason: r.reason ?? '—',
  }));
  return `${table(formatted)}\n`;
}
