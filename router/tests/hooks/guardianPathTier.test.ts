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

function tierTableHook(): Record<string, unknown> {
  const cfg = loadAgentConfig('guardian', { devTeamRoot });
  const hooks = (cfg.settings.hooks?.SessionStart ?? []) as Array<Record<string, unknown>>;
  const hook = hooks.find(
    (h) =>
      h.command === 'load' &&
      Array.isArray(h.paths) &&
      (h.paths as string[]).some((p) => p.endsWith('guardian/sensitive-paths.yml')),
  );
  if (!hook) throw new Error('guardian has no SessionStart load hook for sensitive-paths.yml');
  return hook;
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
    targetProjectRoot: join(devTeamRoot, '..', 'chatbots'),
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
