// Resolve a schedule entry's effective enabled-state per ARCHITECTURE.md §2.8.
//
// Rule chain (in order):
//   1. Runtime override (schedule_overrides) — if present, wins over YAML
//   2. YAML `enabled:` — default when no override
//   3. Project-phase gate — even when enabled, block until phase satisfied
//
// Effective states:
//   - `enabled`     — will fire on the next cron tick
//   - `disabled`    — off by config (YAML false + no override, OR override=false)
//   - `phase_gated` — enabled by config, but project phase < required

import type { Db } from '../state/db.js';
import { getOverride } from '../state/schedule.js';
import { phaseSatisfies, readProjectPhase } from './projectPhase.js';
import type { ScheduleEntry } from './schema.js';

export type EffectiveState = 'enabled' | 'disabled' | 'phase_gated';

export type Effective = {
  entry: ScheduleEntry;
  state: EffectiveState;
  source: 'yaml' | 'override';
  reason?: string;
  overrideReason?: string | undefined;
};

export type EffectiveOptions = {
  db: Db;
  targetProjectRoot?: string | undefined;
};

export function resolveEffective(entry: ScheduleEntry, opts: EffectiveOptions): Effective {
  const override = getOverride(opts.db, entry.id);
  const configuredEnabled = override ? override.enabled === 1 : entry.enabled;
  const source: 'yaml' | 'override' = override ? 'override' : 'yaml';
  const overrideReason = override?.reason ?? undefined;

  if (!configuredEnabled) {
    return {
      entry,
      state: 'disabled',
      source,
      reason: override ? 'runtime override: disabled' : 'yaml: enabled=false',
      ...(overrideReason ? { overrideReason } : {}),
    };
  }

  // Enabled — check phase gate.
  if (entry.requires_project_phase) {
    const current = opts.targetProjectRoot ? readProjectPhase(opts.targetProjectRoot) : 'phase-0';
    if (!phaseSatisfies(current, entry.requires_project_phase)) {
      return {
        entry,
        state: 'phase_gated',
        source,
        reason: `project is ${current}, requires ${entry.requires_project_phase}`,
        ...(overrideReason ? { overrideReason } : {}),
      };
    }
  }

  return {
    entry,
    state: 'enabled',
    source,
    ...(overrideReason ? { overrideReason } : {}),
  };
}

export function resolveAll(entries: ScheduleEntry[], opts: EffectiveOptions): Effective[] {
  return entries.map((e) => resolveEffective(e, opts));
}
