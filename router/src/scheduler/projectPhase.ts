// Read the target project's current phase from `<target-project>/.dev-team.yml`.
//
// File shape:
//   project:
//     phase: phase-2    # or phase-0 .. phase-5
//
// If the file doesn't exist or doesn't parse, we default to `phase-0` (the
// most conservative gate — every schedule with a `requires_project_phase`
// higher than phase-0 will be blocked until the file is set up).

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';

const DevTeamFileSchema = z.object({
  project: z
    .object({
      phase: z.string().default('phase-0'),
    })
    .default({ phase: 'phase-0' }),
});

type Cached = {
  phase: string;
  mtime: number;
  path: string;
};

let cache: Cached | undefined;

export function readProjectPhase(targetProjectRoot: string): string {
  const path = join(targetProjectRoot, '.dev-team.yml');
  const mtime = safeMtime(path);
  if (cache && cache.path === path && cache.mtime === mtime) return cache.phase;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    // File missing → most-conservative gate.
    return 'phase-0';
  }

  let doc: unknown;
  try {
    doc = yaml.load(raw);
  } catch {
    return 'phase-0';
  }
  const parsed = DevTeamFileSchema.safeParse(doc);
  if (!parsed.success) return 'phase-0';

  const phase = parsed.data.project.phase;
  cache = { path, mtime, phase };
  return phase;
}

export function resetProjectPhaseCache(): void {
  cache = undefined;
}

/**
 * Compare project-phase strings. Format: `phase-<N>`; lexicographic ordering
 * matches numeric intent for N < 10.
 * Returns true if `current` is >= `required`.
 */
export function phaseSatisfies(current: string, required: string): boolean {
  const c = parsePhase(current);
  const r = parsePhase(required);
  if (c === null || r === null) return false;
  return c >= r;
}

function parsePhase(s: string): number | null {
  const m = /^phase-(\d+)$/.exec(s);
  if (!m || !m[1]) return null;
  return Number.parseInt(m[1], 10);
}

function safeMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}
