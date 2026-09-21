// A validator that has never been seen to fail is not evidence.
//
// Check 6 guards Guardian's two glob registries, and its whole value is rejecting a
// malformed entry — the failure sensitive-paths.yml's own header calls out: "A
// malformed entry is worse than a missing one: it reads as coverage that is not
// there." So every case below is a deliberately-broken fixture that MUST produce a
// problem, plus the real files, which must produce none.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type GlobRegistrySpec,
  validateGlobRegistry,
  validateGlobRegistryFile,
} from '../../src/config/globRegistry.js';

const repoRoot = join(process.cwd(), '..');

const TIER_SPEC: GlobRegistrySpec = {
  label: 'guardian/sensitive-paths.yml',
  taxonomyKey: 'families',
  entryKey: 'family',
  requireSkip: true,
};

const PERF_SPEC: GlobRegistrySpec = {
  label: 'guardian/perf-sensitive-paths.yml',
  taxonomyKey: 'categories',
  entryKey: 'category',
  requireSkip: false,
};

/** A minimal well-formed registry in whichever of the two shapes is asked for. */
function fixture(spec: GlobRegistrySpec, entries: string, extra = ''): string {
  const skip = spec.requireSkip ? 'skip:\n  - "**/*.md"\n' : '';
  return `version: 1\n${spec.taxonomyKey}:\n  - alpha\n  - beta\n${skip}${extra}patterns:\n${entries}`;
}

const GOOD_ENTRY = (spec: GlobRegistrySpec, glob = 'packages/db/**', member = 'alpha') =>
  `  - glob: "${glob}"\n    ${spec.entryKey}: ${member}\n    added: 2026-09-10\n    reason: because it matters\n`;

describe.each([
  ['sensitive-paths.yml', TIER_SPEC],
  ['perf-sensitive-paths.yml', PERF_SPEC],
] as const)('validateGlobRegistry — %s shape', (_name, spec) => {
  it('accepts a well-formed registry', () => {
    expect(validateGlobRegistry(fixture(spec, GOOD_ENTRY(spec)), spec)).toEqual([]);
  });

  it('rejects an undeclared taxonomy member', () => {
    const problems = validateGlobRegistry(
      fixture(spec, GOOD_ENTRY(spec, 'packages/db/**', 'not-a-real-one')),
      spec,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('not in the declared');
    expect(problems[0]).toContain(spec.taxonomyKey);
  });

  it('rejects a duplicate glob', () => {
    const problems = validateGlobRegistry(fixture(spec, GOOD_ENTRY(spec) + GOOD_ENTRY(spec)), spec);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("duplicate glob 'packages/db/**'");
  });

  it('rejects a missing reason', () => {
    const entry = `  - glob: "packages/db/**"\n    ${spec.entryKey}: alpha\n    added: 2026-09-10\n`;
    const problems = validateGlobRegistry(fixture(spec, entry), spec);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('`reason`');
  });

  it('rejects an empty-string reason, not just an absent one', () => {
    const entry = `  - glob: "packages/db/**"\n    ${spec.entryKey}: alpha\n    added: 2026-09-10\n    reason: "   "\n`;
    const problems = validateGlobRegistry(fixture(spec, entry), spec);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('`reason`');
  });

  // Each of these must fail. `not-a-date` is the one that matters: #59 found the
  // inline check accepted any non-empty string while its diagnostic claimed "usable
  // date", and this branch was cut before that fix. Without this case the refactor
  // would have silently reverted it.
  it.each([
    ['empty', '""'],
    ['unparseable', 'not-a-date'],
    ['whitespace', '"   "'],
  ])('rejects an %s added date', (_label, value) => {
    const entry = `  - glob: "packages/db/**"\n    ${spec.entryKey}: alpha\n    added: ${value}\n    reason: because it matters\n`;
    const problems = validateGlobRegistry(fixture(spec, entry), spec);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('`added`');
  });

  it('accepts a real date in either YAML form', () => {
    for (const value of ['2026-09-10', '"2026-09-10"']) {
      const entry = `  - glob: "packages/db/**"\n    ${spec.entryKey}: alpha\n    added: ${value}\n    reason: because it matters\n`;
      expect(validateGlobRegistry(fixture(spec, entry), spec)).toEqual([]);
    }
  });

  it('rejects an entry with no glob at all', () => {
    const entry = `  - ${spec.entryKey}: alpha\n    added: 2026-09-10\n    reason: because it matters\n`;
    const problems = validateGlobRegistry(fixture(spec, entry), spec);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('has no `glob`');
  });

  it('rejects a missing or empty taxonomy list', () => {
    const noTaxonomy = fixture(spec, GOOD_ENTRY(spec)).replace(
      `${spec.taxonomyKey}:\n  - alpha\n  - beta\n`,
      '',
    );
    const problems = validateGlobRegistry(noTaxonomy, spec);
    expect(problems.some((p) => p.includes(`\`${spec.taxonomyKey}\` is missing or empty`))).toBe(
      true,
    );
  });

  it('rejects empty patterns', () => {
    expect(validateGlobRegistry(fixture(spec, '  []\n'), spec)).toEqual([
      `${spec.label}: \`patterns\` is missing or empty`,
    ]);
  });

  it('reports unparseable YAML rather than throwing', () => {
    const problems = validateGlobRegistry('patterns: [\n  - unclosed', spec);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('could not parse');
  });

  it('names itself in every problem, so a reader can tell the files apart', () => {
    const problems = validateGlobRegistry(
      fixture(spec, GOOD_ENTRY(spec, 'a/**', 'nope') + GOOD_ENTRY(spec, 'a/**', 'nope')),
      spec,
    );
    expect(problems.length).toBeGreaterThan(1);
    for (const p of problems) expect(p.startsWith(`${spec.label}: `)).toBe(true);
  });
});

describe('the requireSkip difference between the two files', () => {
  const entries = GOOD_ENTRY(TIER_SPEC);

  it('demands `skip` on the tier table', () => {
    const withoutSkip = `version: 1\nfamilies:\n  - alpha\npatterns:\n${entries}`;
    expect(validateGlobRegistry(withoutSkip, TIER_SPEC)).toEqual([
      'guardian/sensitive-paths.yml: `skip` must be a list of globs',
    ]);
  });

  it('does not demand it on the perf registry', () => {
    const perfEntries = GOOD_ENTRY(PERF_SPEC);
    const withoutSkip = `version: 1\ncategories:\n  - alpha\npatterns:\n${perfEntries}`;
    expect(validateGlobRegistry(withoutSkip, PERF_SPEC)).toEqual([]);
  });
});

describe('the real registries', () => {
  // Duplicated from validate:fleet deliberately: ci.yml filters on `router/**` and
  // fleet-config.yml on `agents/**`, so an edit to ONE of them runs only one of the
  // two checks. These files are edited from both sides.
  it.each([
    ['sensitive-paths.yml', TIER_SPEC],
    ['perf-sensitive-paths.yml', PERF_SPEC],
  ] as const)('%s is well-formed', (file, spec) => {
    const problems = validateGlobRegistryFile(
      join(repoRoot, 'agents', 'guardian', file),
      spec,
      (p) => readFileSync(p, 'utf-8'),
    );
    expect(problems).toEqual([]);
  });

  it('reports an unreadable file instead of throwing', () => {
    const problems = validateGlobRegistryFile(
      join(repoRoot, 'agents', 'guardian', 'does-not-exist.yml'),
      TIER_SPEC,
      (p) => readFileSync(p, 'utf-8'),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('could not read');
  });
});
