// Guardian's path-tier table actually reaching a scanning session.
//
// It replaced a `classify_path_tier` SessionStart hook that had no handler and
// could never have had one: SessionStart runs in preflight, before the worktree is
// leased and before secrets resolve, so nothing in that phase can fetch a PR's
// changed files. The table is loaded instead, and the `qa` skill classifies.
//
// The gate on the file's SHAPE lives in validate-fleet-config.ts, which runs on
// `agents/**`. This is the other half: that the hook DELIVERS it, and that the
// cheap conversational default does not pay for it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { loadAgentConfig } from '../../src/config/agentLoader.js';
import { loadHandler } from '../../src/hooks/commands/load.js';
import type { SessionContext } from '../../src/hooks/types.js';

const devTeamRoot = join(process.cwd(), '..');
const log = pino({ level: 'silent' });

/**
 * The LAST `load` hook whose paths end with `file`. Guardian declares two registries
 * and delivers them at different tiers, so "the hook for this file" has to be found by
 * filename, not by position — and `endsWith` matters: `sensitive-paths.yml` is a suffix
 * of `perf-sensitive-paths.yml`, so a naive `includes` finds the wrong hook.
 */
function registryHook(file: string): Record<string, unknown> {
  const cfg = loadAgentConfig('guardian', { devTeamRoot });
  const hooks = (cfg.settings.hooks?.SessionStart ?? []) as Array<Record<string, unknown>>;
  const hook = hooks.find(
    (h) =>
      h.command === 'load' &&
      Array.isArray(h.paths) &&
      (h.paths as string[]).some((p) => p.endsWith(`guardian/${file}`)),
  );
  if (!hook) throw new Error(`guardian has no SessionStart load hook for ${file}`);
  return hook;
}

function tierTableHook(): Record<string, unknown> {
  return registryHook('sensitive-paths.yml');
}

function ctxFor(skill: string): SessionContext {
  return {
    agent: 'guardian',
    skill,
    sessionId: 1,
    workspaceDir: undefined,
    trigger: { kind: 'webhook:github' as const },
    env: {},
    devTeamRoot,
    // Unused by this hook (it loads only a dev-team path) and deliberately not
    // pointed at a sibling checkout: CI has only this repo, so a test that reads
    // one passes locally and fails there — which is exactly how #50 broke.
    targetProjectRoot: join(devTeamRoot, 'no-target-project-in-this-test'),
    projectName: 'iris',
    db: undefined as never,
    log,
  } as unknown as SessionContext;
}

describe('guardian path-tier table', () => {
  it('reaches a qa session, with the deep patterns in it', async () => {
    const res = await loadHandler(tierTableHook(), ctxFor('qa'));
    expect(res.kind).toBe('context');
    const content = (res as { content: string }).content;
    // The concrete entries are the ones a reviewer would miss if the table were
    // empty — a migration or a schema change reviewed at light tier.
    expect(content).toContain('packages/db/drizzle/**');
    expect(content).toContain('.github/workflows/**');
    expect(content).toContain('families:');
  });

  it('does NOT load for the cheap conversational default', async () => {
    // A bare question to Guardian classifies no PR. Paying ~1.9K tokens to
    // cache-write the table on a Haiku session is the cost this only_skills list
    // exists to avoid.
    const res = await loadHandler(tierTableHook(), ctxFor('conversational'));
    expect(res.kind).toBe('side-effect');
  });

  it('every deep pattern names a declared family, and reasons are non-empty', async () => {
    // Duplicated from validate:fleet on purpose: ci.yml filters on `router/**` and
    // fleet-config.yml on `agents/**`, so an edit to ONE of them runs only one of
    // the two checks. The file is edited from both sides.
    const doc = load(
      readFileSync(join(devTeamRoot, 'agents', 'guardian', 'sensitive-paths.yml'), 'utf-8'),
    ) as { families: string[]; skip: string[]; patterns: Array<Record<string, unknown>> };

    expect(doc.families.length).toBeGreaterThan(0);
    expect(doc.skip.length).toBeGreaterThan(0);
    expect(doc.patterns.length).toBeGreaterThan(0);

    const families = new Set(doc.families);
    for (const entry of doc.patterns) {
      expect(typeof entry.glob).toBe('string');
      expect(families.has(entry.family as string)).toBe(true);
      expect(String(entry.reason ?? '').trim().length).toBeGreaterThan(0);
    }
  });
});

// HAR-10. perf-sensitive-paths.yml shipped in #54 and no hook loaded it, so the
// `performance` skill's first documented activation trigger — "Paths in perf-sensitive
// areas (defined in agents/guardian/perf-sensitive-paths.yml)" — had nothing to match
// against. Same shape as the block above: that the hook DELIVERS the file, and that the
// skills which never consult it do not pay for it.
describe('guardian perf-scan registry', () => {
  const perfHook = () => registryHook('perf-sensitive-paths.yml');

  it('reaches a performance session, with the perf patterns in it', async () => {
    const res = await loadHandler(perfHook(), ctxFor('performance'));
    expect(res.kind).toBe('context');
    const content = (res as { content: string }).content;
    // Match the load header, not a bare path: sensitive-paths.yml's own prose cites
    // this file, so a substring check reports it loaded when only a reference is.
    expect(content).toContain('# dev-team/agents/guardian/perf-sensitive-paths.yml');
    expect(content).toContain('packages/db/src/schema/knowledge.ts');
    expect(content).toContain('vector-retrieval');
    expect(content).toContain('categories:');
  });

  it.each(['qa', 'security', 'conversational'])('does NOT load for a %s session', async (skill) => {
    // The only_skills gate is the whole point. qa and security are the two that would
    // otherwise pick it up cheaply-looking — they already carry the heaviest hook, and
    // neither reads this registry.
    const res = await loadHandler(perfHook(), ctxFor(skill));
    expect(res.kind).toBe('side-effect');
  });

  it('is a DIFFERENT hook from the one carrying sensitive-paths.yml', () => {
    // Guards the endsWith above. If a future edit folds the perf registry into the
    // tier-table hook, the negative assertions become vacuous rather than failing.
    expect(perfHook()).not.toBe(tierTableHook());
    expect(perfHook().only_skills).toEqual(['performance']);
  });

  it('every pattern names a declared category, and reasons are non-empty', () => {
    // Duplicated from validate:fleet deliberately — except validate:fleet does NOT
    // cover this file yet (that is HAR-12). Until it does, this is the only check on
    // the shape of a registry Guardian is permitted to edit itself.
    const doc = load(
      readFileSync(join(devTeamRoot, 'agents', 'guardian', 'perf-sensitive-paths.yml'), 'utf-8'),
    ) as { categories: string[]; patterns: Array<Record<string, unknown>> };

    expect(doc.categories.length).toBeGreaterThan(0);
    expect(doc.patterns.length).toBeGreaterThan(0);

    const categories = new Set(doc.categories);
    const seen = new Set<string>();
    for (const entry of doc.patterns) {
      const glob = entry.glob as string;
      expect(typeof glob).toBe('string');
      expect(seen.has(glob)).toBe(false);
      seen.add(glob);
      expect(categories.has(entry.category as string)).toBe(true);
      expect(String(entry.reason ?? '').trim().length).toBeGreaterThan(0);
      expect(Number.isNaN(new Date(String(entry.added)).getTime())).toBe(false);
    }
  });
});
