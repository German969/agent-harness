// Identity file loader. Reads identities/*.yml, parses each with zod, returns
// a validated Identity[]. Files with parse errors are skipped with a warning
// (per router/ARCHITECTURE.md — a bad file for one project shouldn't break the
// whole fleet).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { type Identity, IdentityFileSchema, isKnownAgent } from './schema.js';

export type LoadResult = {
  identities: Identity[];
  errors: Array<{ file: string; reason: string }>;
};

/**
 * Load every `<agent>.yml` under `identitiesDir`. Skips README.md (or any
 * non-.yml file). Returns validated identities + a list of files that failed
 * to parse or validate.
 */
export function loadIdentities(identitiesDir: string): LoadResult {
  let files: string[];
  try {
    files = readdirSync(identitiesDir);
  } catch (err) {
    return {
      identities: [],
      errors: [{ file: identitiesDir, reason: `unreadable dir: ${(err as Error).message}` }],
    };
  }

  const identities: Identity[] = [];
  const errors: LoadResult['errors'] = [];

  for (const file of files) {
    if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
    const path = join(identitiesDir, file);

    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }

    try {
      const raw = readFileSync(path, 'utf-8');
      const parsedYaml = yaml.load(raw);
      const parsed = IdentityFileSchema.parse(parsedYaml);
      if (!isKnownAgent(parsed.agent)) {
        errors.push({ file, reason: `unknown agent id: ${parsed.agent}` });
        continue;
      }
      identities.push(parsed as Identity);
    } catch (err) {
      errors.push({ file, reason: (err as Error).message });
    }
  }

  return { identities, errors };
}
