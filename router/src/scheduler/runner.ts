// Scheduler runner — registers croner jobs for every enabled schedule entry.
//
// Design:
//   - Register ONE croner job per entry. The tick handler re-resolves the
//     effective state at fire time (so runtime enables/disables + phase-gate
//     changes take effect without restart).
//   - Overlap protection: if the last run's session is still `running`, skip
//     this tick (records `skipped_overlap`).
//   - Fire time synthesizes a `TriggerDescriptor` and hands off to the
//     `onTick` callback — Phase 9 does NOT wire the classifier/runtime directly.
//     The callback surface keeps the runner testable + lets the entrypoint
//     wire it however Phase 12 (integration) prefers.

import { Cron } from 'croner';
import type { Logger } from 'pino';
import type { Db } from '../state/db.js';
import { type ScheduleOutcome, hasActiveRunFor, recordRun } from '../state/schedule.js';
import type { AgentId } from '../types.js';
import { resolveEffective } from './effective.js';
import type { ScheduleEntry } from './schema.js';

export type ScheduledTrigger = {
  kind: 'scheduled';
  cron_id: string;
  agent: AgentId;
  skill?: string | undefined;
  message: string;
  timezone: string;
  reply_to?:
    | {
        provider: 'slack' | 'linear' | 'github';
        channel?: string | undefined;
        thread_ts?: string | undefined;
        linear_team?: string | undefined;
      }
    | undefined;
  firedAt: number;
};

export type OnTickHandler = (trigger: ScheduledTrigger) => Promise<void>;

export type RunnerOptions = {
  db: Db;
  log: Logger;
  targetProjectRoot?: string | undefined;
  onTick: OnTickHandler;
};

export type ScheduledJob = {
  entry: ScheduleEntry;
  cron: Cron;
};

/**
 * Build croner jobs for every entry. Every job is registered regardless of
 * `enabled` — effective state is re-evaluated at each tick. This mirrors the
 * "hot toggle" story: `/agents schedule enable X` takes effect on the next
 * scheduled tick without a restart.
 */
export function registerJobs(entries: ScheduleEntry[], opts: RunnerOptions): ScheduledJob[] {
  return entries.map((entry) => ({
    entry,
    cron: new Cron(
      entry.cron,
      {
        timezone: entry.timezone,
        name: entry.id,
        catch: (err) => opts.log.error({ cron_id: entry.id, err }, 'croner threw'),
      },
      () => {
        // Wrap handleTick so the croner callback returns void, not ScheduleOutcome.
        handleTick(entry, opts).catch((err) => {
          opts.log.error({ cron_id: entry.id, err: (err as Error).message }, 'onTick failed');
        });
      },
    ),
  }));
}

/**
 * Fire a schedule entry once, right now — bypasses cron. Used by:
 *   - `/agents schedule run <id>` (admin trigger)
 *   - integration tests
 * Applies the same effective-state resolution + overlap guard.
 */
export async function fireOnce(
  entry: ScheduleEntry,
  opts: RunnerOptions,
): Promise<ScheduleOutcome> {
  return handleTick(entry, opts);
}

async function handleTick(entry: ScheduleEntry, opts: RunnerOptions): Promise<ScheduleOutcome> {
  const eff = resolveEffective(entry, {
    db: opts.db,
    ...(opts.targetProjectRoot ? { targetProjectRoot: opts.targetProjectRoot } : {}),
  });

  if (eff.state === 'disabled') {
    recordRun(opts.db, entry.id, entry.agent, 'skipped_disabled');
    opts.log.debug({ cron_id: entry.id }, 'schedule tick — disabled, skipping');
    return 'skipped_disabled';
  }
  if (eff.state === 'phase_gated') {
    recordRun(opts.db, entry.id, entry.agent, 'skipped_phase_gate');
    opts.log.info(
      { cron_id: entry.id, reason: eff.reason },
      'schedule tick — phase-gated, skipping',
    );
    return 'skipped_phase_gate';
  }

  // Overlap guard.
  if (hasActiveRunFor(opts.db, entry.id)) {
    recordRun(opts.db, entry.id, entry.agent, 'skipped_overlap');
    opts.log.warn({ cron_id: entry.id }, 'schedule tick — prior run still active, skipping');
    return 'skipped_overlap';
  }

  // Fire.
  const trigger: ScheduledTrigger = {
    kind: 'scheduled',
    cron_id: entry.id,
    agent: entry.agent,
    ...(entry.skill ? { skill: entry.skill } : {}),
    message: entry.trigger.message,
    timezone: entry.timezone,
    ...(entry.trigger.reply_to ? { reply_to: entry.trigger.reply_to } : {}),
    firedAt: Date.now(),
  };

  try {
    await opts.onTick(trigger);
    recordRun(opts.db, entry.id, entry.agent, 'started');
    return 'started';
  } catch (err) {
    opts.log.error(
      { cron_id: entry.id, err: (err as Error).message },
      'scheduled onTick threw — recording failed_to_start',
    );
    recordRun(opts.db, entry.id, entry.agent, 'failed_to_start');
    return 'failed_to_start';
  }
}

/** Stop every job — used in tests + on router shutdown. */
export function stopAll(jobs: ScheduledJob[]): void {
  for (const j of jobs) j.cron.stop();
}
