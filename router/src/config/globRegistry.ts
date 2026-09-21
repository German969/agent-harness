// Shape validation for Guardian's glob registries.
//
// Two files share one shape with small deliberate differences:
//
//   agents/guardian/sensitive-paths.yml       families / family / has `skip`
//   agents/guardian/perf-sensitive-paths.yml  categories / category / no `skip`
//
// One code path over both, rather than two copies that drift. The invariants are
// the same in either case, and `sensitive-paths.yml`'s own header says why they
// matter: "A malformed entry is worse than a missing one: it reads as coverage
// that is not there." The tier table still loads, and a deep path reviews light.
//
// These are also the only files Guardian is permitted to edit itself, so they are
// the most likely in the fleet to be written by a machine and the least likely to
// be eyeballed.
//
// Lives in src/ rather than beside the script that calls it because `tsconfig`
// scopes to `src/**` and lint runs `biome check src tests` — a helper under
// `scripts/` would be checked by neither, which is a poor place for the code that
// IS the check.

import { load } from 'js-yaml';

export type GlobRegistrySpec = {
  /** How the file is named in problem messages, e.g. `guardian/sensitive-paths.yml`. */
  label: string;
  /** Top-level key holding the declared taxonomy list (`families` / `categories`). */
  taxonomyKey: string;
  /** Per-entry field naming one member of that taxonomy (`family` / `category`). */
  entryKey: string;
  /** Whether a top-level `skip` list of globs is required. Only the tier table has one. */
  requireSkip: boolean;
};

/**
 * Validate one registry's parsed shape. Returns a list of problems; empty means valid.
 *
 * Takes the YAML text rather than a path so a test can hand it a deliberately-broken
 * fixture inline. `validateGlobRegistryFile` below is the path-taking wrapper.
 */
/**
 * `added` is an unquoted ISO date, which js-yaml resolves to a Date rather than a string
 * — accept either. A string is only usable if it PARSES.
 *
 * Moved here from validate-fleet-config.ts, where #59 introduced it after finding the
 * inline check accepted any non-empty text while its own diagnostic said "usable date":
 * `added: not-a-date` passed. This branch was cut before #59 landed, so folding that
 * block into the helper without carrying the fix would have silently reintroduced the
 * bug the fleet had just closed.
 */
export function isUsableDate(value: unknown): boolean {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value !== 'string' || value.trim() === '') return false;
  return !Number.isNaN(new Date(value).getTime());
}

export function validateGlobRegistry(text: string, spec: GlobRegistrySpec): string[] {
  const problems: string[] = [];
  const at = (msg: string) => problems.push(`${spec.label}: ${msg}`);

  let doc: Record<string, unknown>;
  try {
    doc = (load(text) ?? {}) as Record<string, unknown>;
  } catch (err) {
    return [`${spec.label}: could not parse — ${(err as Error).message}`];
  }

  const taxonomyRaw = doc[spec.taxonomyKey];
  const taxonomy = Array.isArray(taxonomyRaw) ? (taxonomyRaw as string[]) : undefined;
  if (!taxonomy || taxonomy.length === 0) {
    at(`\`${spec.taxonomyKey}\` is missing or empty`);
  }

  if (spec.requireSkip && !Array.isArray(doc.skip)) {
    at('`skip` must be a list of globs');
  }

  const patterns = Array.isArray(doc.patterns) ? doc.patterns : undefined;
  if (!patterns || patterns.length === 0) {
    at('`patterns` is missing or empty');
    return problems;
  }

  const declared = new Set(taxonomy ?? []);
  const seen = new Set<string>();

  for (const raw of patterns) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const glob = typeof entry.glob === 'string' ? entry.glob : undefined;
    if (!glob) {
      at(`an entry has no \`glob\`: ${JSON.stringify(raw)}`);
      continue;
    }
    if (seen.has(glob)) {
      at(`duplicate glob '${glob}'`);
    }
    seen.add(glob);

    // `reason` is not decoration: PROTOCOLS.md §2 requires every addition to say why,
    // so a future reader can judge whether it still applies.
    for (const field of [spec.entryKey, 'reason']) {
      const value = entry[field];
      if (typeof value !== 'string' || value.trim() === '') {
        at(`'${glob}' has no \`${field}\``);
      }
    }

    if (!isUsableDate(entry.added)) {
      at(`'${glob}' has no usable \`added\` date`);
    }

    const member = entry[spec.entryKey];
    if (typeof member === 'string' && !declared.has(member)) {
      at(
        `'${glob}' names ${spec.entryKey} '${member}', which is not in the declared ${spec.taxonomyKey} list`,
      );
    }
  }

  return problems;
}

/** `validateGlobRegistry` over a file, reporting an unreadable file as a problem. */
export function validateGlobRegistryFile(
  path: string,
  spec: GlobRegistrySpec,
  readFile: (p: string) => string,
): string[] {
  let text: string;
  try {
    text = readFile(path);
  } catch (err) {
    return [`${spec.label}: could not read — ${(err as Error).message}`];
  }
  return validateGlobRegistry(text, spec);
}
