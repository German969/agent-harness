// Load + validate scheduler/schedules.yml.
//
// Files may contain nested `_comment` scaffolding + real entries. YAML lists
// mix comments with data cleanly (comments are stripped by the parser), so
// after parsing we just zod-validate each entry.

import { readFileSync, statSync } from 'node:fs';
import yaml from 'js-yaml';
import { type ScheduleEntry, SchedulesFileSchema } from './schema.js';

export class ScheduleFileError extends Error {
  override readonly name = 'ScheduleFileError';
  constructor(
    public readonly file: string,
    public readonly reason: string,
  ) {
    super(`schedules.yml error at ${file}: ${reason}`);
  }
}

type Cached = {
  entries: ScheduleEntry[];
  mtime: number;
  path: string;
};

let cache: Cached | undefined;

/**
 * Load the schedules file. Returns cached entries if the file's mtime is
 * unchanged since the last load; otherwise re-reads + re-validates.
 *
 * Duplicate ids throw — every entry must have a unique `id`.
 */
export function loadSchedules(path: string): ScheduleEntry[] {
  const mtime = safeMtime(path);
  if (cache && cache.path === path && cache.mtime === mtime) return cache.entries;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new ScheduleFileError(path, `read failed: ${(err as Error).message}`);
  }

  let doc: unknown;
  try {
    doc = yaml.load(raw);
  } catch (err) {
    throw new ScheduleFileError(path, `yaml parse failed: ${(err as Error).message}`);
  }

  const parsed = SchedulesFileSchema.safeParse(doc);
  if (!parsed.success) {
    throw new ScheduleFileError(
      path,
      `schema validation failed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const entries = parsed.data;

  // Duplicate id detection.
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.id)) {
      throw new ScheduleFileError(path, `duplicate id: ${e.id}`);
    }
    seen.add(e.id);
  }

  cache = { entries, mtime, path };
  return entries;
}

/** Test-only: drop the cache so a subsequent `loadSchedules` re-reads. */
export function resetScheduleCache(): void {
  cache = undefined;
}

function safeMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}
