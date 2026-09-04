// Which founding docs a session actually pays for.
//
// The always-on hook's comment called them "Small + needed by every skill". Measured
// (#46): 99KB / ~25K tokens, cache-written on EVERY session including the Haiku
// conversational ones, whose whole reason to exist is not paying for context a
// one-line answer will not use.
//
// The invariant, not the byte count: the cheap tier must not load the heavy docs,
// and the work tier must. A size assertion would fail the day someone edits
// PRODUCT.md, which is not a regression.
//
// HERMETIC BY CONSTRUCTION. The first version pointed targetProjectRoot at a sibling
// `chatbots` checkout and passed locally, where one exists — CI has only this repo,
// so every founding path was missing, `missing: warn` skipped it, and 15 assertions
// failed. The fixture below supplies the target project and the state repo; only the
// AGENT CONFIGS are real, which is the part under test.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearAgentConfigCache, loadAgentConfig } from '../../src/config/agentLoader.js';
import { loadHandler } from '../../src/hooks/commands/load.js';
import type { SessionContext } from '../../src/hooks/types.js';

const realRepoRoot = join(process.cwd(), '..');
const log = pino({ level: 'silent' });

/** The agent's primary work skill — what its work-trigger default resolves to. */
const WORK_SKILL: Record<string, string> = {
  strategist: 'pm',
  platform: 'architect',
  'builder-server': 'backend',
  'builder-client': 'frontend',
  guardian: 'qa',
  marketer: 'campaign-lead',
  harness: 'agent-modifier',
};
const AGENTS = Object.keys(WORK_SKILL);

let fixture: string;
let devTeamRoot: string;
let targetProjectRoot: string;

beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), 'founding-tiers-'));
  devTeamRoot = join(fixture, 'dev-team');
  targetProjectRoot = join(fixture, 'chatbots');
  mkdirSync(devTeamRoot, { recursive: true });

  // The REAL agent configs — the thing under test — reached through the fixture root.
  symlinkSync(join(realRepoRoot, 'agents'), join(devTeamRoot, 'agents'), 'dir');

  mkdirSync(join(targetProjectRoot, 'founding'), { recursive: true });
  for (const doc of ['PRODUCT.md', 'BRAND.md', 'STACK.md', 'COMPLIANCE.md']) {
    writeFileSync(join(targetProjectRoot, 'founding', doc), `# ${doc} fixture\n`, 'utf-8');
  }
  // dev-team-state resolves as a SIBLING of devTeamRoot (see hooks/placeholder.ts).
  mkdirSync(join(fixture, 'dev-team-state', 'shared', 'process'), { recursive: true });
  writeFileSync(join(fixture, 'dev-team-state', 'shared', 'README.md'), '# vault\n', 'utf-8');
  writeFileSync(
    join(fixture, 'dev-team-state', 'shared', 'process', 'README.md'),
    '# process\n',
    'utf-8',
  );
  clearAgentConfigCache();
});

afterAll(() => {
  rmSync(fixture, { recursive: true, force: true });
  clearAgentConfigCache();
});

/**
 * The `load` handler renders each file it loads under a `# <path>` header. Match on
 * the HEADER, not on the path appearing anywhere in the content — STACK.md's own
 * prose cites `founding/PRODUCT.md` several times, so a substring check reports a
 * document as loaded when only a cross-reference to it is.
 */
function loadsDoc(content: string, doc: string): boolean {
  return content.includes(`# <target-project>/founding/${doc}`);
}

async function loadedFor(agent: string, skill: string): Promise<string> {
  const cfg = loadAgentConfig(agent as never, { devTeamRoot });
  const ctx = {
    agent,
    skill,
    sessionId: 1,
    workspaceDir: undefined,
    trigger: { kind: 'webhook:slack' as const },
    env: {},
    devTeamRoot,
    targetProjectRoot,
    projectName: 'iris',
    db: undefined as never,
    log,
  } as unknown as SessionContext;

  let out = '';
  for (const hook of (cfg.settings.hooks?.SessionStart ?? []) as Array<Record<string, unknown>>) {
    if (hook.command !== 'load') continue;
    const res = await loadHandler(hook, ctx);
    if (res.kind === 'context') out += (res as { content: string }).content;
  }
  return out;
}

describe('founding docs are on the work tier, not the cheap one', () => {
  it.each(AGENTS)('%s: conversational does not load PRODUCT.md or COMPLIANCE.md', async (agent) => {
    const loaded = await loadedFor(agent, 'conversational');
    expect(loadsDoc(loaded, 'PRODUCT.md')).toBe(false);
    expect(loadsDoc(loaded, 'COMPLIANCE.md')).toBe(false);
  });

  it.each(AGENTS)('%s: conversational still gets STACK.md and the vault index', async (agent) => {
    // STACK.md is what a bare "what are we running?" needs, and it is the smallest
    // of the four. Dropping everything would make the cheap tier useless rather
    // than cheap.
    const loaded = await loadedFor(agent, 'conversational');
    expect(loadsDoc(loaded, 'STACK.md')).toBe(true);
    expect(loaded).toContain('# dev-team-state/shared/README.md');
  });

  it.each(AGENTS)('%s: the work skill loads the full founding set', async (agent) => {
    const loaded = await loadedFor(agent, WORK_SKILL[agent] as string);
    for (const doc of ['PRODUCT.md', 'BRAND.md', 'COMPLIANCE.md', 'STACK.md']) {
      expect(loadsDoc(loaded, doc)).toBe(true);
    }
  });

  it('marketer keeps BRAND.md on the cheap tier, because its skill says it needs it', async () => {
    // marketer/skills/conversational.md: "Answers from loaded house-style context
    // (BRAND.md especially)" and "BRAND.md is your primary reference". Moving it
    // would have broken a documented behaviour to save tokens.
    expect(loadsDoc(await loadedFor('marketer', 'conversational'), 'BRAND.md')).toBe(true);
    // …and nobody else pays for it on a bare mention.
    expect(loadsDoc(await loadedFor('strategist', 'conversational'), 'BRAND.md')).toBe(false);
  });
});
