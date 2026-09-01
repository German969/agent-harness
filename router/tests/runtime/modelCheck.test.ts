// The unpriced-model warning. `isPricedModel` shipped with PR #24 and had no
// callers anywhere in src/, so an agent configured with a model the rate table
// does not know was billed at the most expensive known rate — silently. These
// are the two call sites that make it say so.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAgentConfigCache } from '../../src/config/agentLoader.js';
import { auditFleetModels, warnIfUnpricedModel } from '../../src/runtime/modelCheck.js';

type Warning = { obj: Record<string, unknown>; msg: string };

function mkLog(): { warn: (obj: object, msg: string) => void; warnings: Warning[] } {
  const warnings: Warning[] = [];
  return {
    warnings,
    warn: (obj: object, msg: string) => warnings.push({ obj: obj as Record<string, unknown>, msg }),
  };
}

function mkAgent(root: string, agent: string, settings: Record<string, unknown>): void {
  const dir = join(root, 'agents', agent);
  mkdirSync(join(dir, 'skills'), { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), `# ${agent}`, 'utf-8');
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({
      max_turns: 40,
      costCap: {
        perJobCostUsd: 5,
        monthlyCostUsd: 100,
        warnAtPercent: 80,
        onCapReached: 'refuse_session',
      },
      permissions: { allow: [], ask: [], deny: [] },
      writeScope: { allowedPaths: [], deniedPaths: [] },
      hooks: { SessionStart: [], PreToolUse: [], PostToolUse: [], SessionEnd: [] },
      ...settings,
    }),
    'utf-8',
  );
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: {} }), 'utf-8');
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'modelcheck-'));
  clearAgentConfigCache();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('warnIfUnpricedModel', () => {
  it('says nothing for a model the table prices', () => {
    const log = mkLog();
    warnIfUnpricedModel('claude-sonnet-5', log, { agent: 'strategist' });
    expect(log.warnings).toEqual([]);
  });

  it('says nothing for a pinned snapshot of a priced model', () => {
    // Agents pin real IDs with a date suffix; normalizeModelId strips it, so a
    // pinned model must not be reported as unknown.
    const log = mkLog();
    warnIfUnpricedModel('claude-haiku-4-5-20251001', log, { agent: 'strategist' });
    expect(log.warnings).toEqual([]);
  });

  it('warns for an unpriced model, naming what configured it and what is valid', () => {
    const log = mkLog();
    warnIfUnpricedModel('claude-sonnet-4-7', log, { agent: 'newbie', source: 'settings.model' });

    expect(log.warnings).toHaveLength(1);
    const w = log.warnings[0];
    expect(w?.obj.model).toBe('claude-sonnet-4-7');
    expect(w?.obj.agent).toBe('newbie');
    expect(w?.obj.source).toBe('settings.model');
    // The message has to say WHY it matters, or it reads as cosmetic and gets ignored.
    expect(w?.msg).toContain('cost cap will fire early');
    // The valid set comes from the table itself, so the message can never list
    // models the code does not actually honour.
    expect(w?.obj.priced_models).toContain('claude-sonnet-5');
    expect(w?.obj.priced_models).not.toContain('claude-sonnet-4-7');
  });
});

describe('auditFleetModels', () => {
  it('finds nothing when every agent is priced', () => {
    mkAgent(root, 'strategist', { model: 'claude-sonnet-5' });
    mkAgent(root, 'guardian', { model: 'claude-opus-5' });
    const log = mkLog();

    expect(auditFleetModels(['strategist', 'guardian'], root, log)).toBe(0);
    expect(log.warnings).toEqual([]);
  });

  it('flags the exact ID the onboarding skill used to prescribe', () => {
    // agents/harness/skills/agent-architect.md told the author to set
    // `claude-sonnet-4-7`, which is not a model. A newly onboarded agent would
    // have billed at Fable-5 rates against its cap with nothing said.
    mkAgent(root, 'newbie', { model: 'claude-sonnet-4-7' });
    const log = mkLog();

    expect(auditFleetModels(['newbie'], root, log)).toBe(1);
    expect(log.warnings[0]?.obj.model).toBe('claude-sonnet-4-7');
  });

  it('checks skill overrides, not just the default model', () => {
    // A per-skill override is the easier one to get wrong — it is never exercised
    // until that specific skill runs.
    mkAgent(root, 'newbie', {
      model: 'claude-sonnet-5',
      modelOverrides: { founding: 'claude-opus-9', ba: 'claude-opus-5' },
    });
    const log = mkLog();

    expect(auditFleetModels(['newbie'], root, log)).toBe(1);
    expect(log.warnings[0]?.obj.skill).toBe('founding');
    expect(log.warnings[0]?.obj.source).toBe('settings.modelOverrides');
  });

  it('ignores the _comment key every agent uses to document its overrides', () => {
    // modelOverrides is a plain string map, so `_comment` is indistinguishable from
    // a skill name by type. Reading it as a model made this audit warn on all seven
    // agents at boot — a false positive in the one place that exists to be believed.
    mkAgent(root, 'newbie', {
      model: 'claude-sonnet-5',
      modelOverrides: {
        _comment: 'conversational runs on Haiku; work skills stay on Sonnet 5.',
        conversational: 'claude-haiku-4-5',
      },
    });
    const log = mkLog();

    expect(auditFleetModels(['newbie'], root, log)).toBe(0);
    expect(log.warnings).toEqual([]);
  });

  it('a config that will not load is skipped, never thrown — boot must not depend on this', () => {
    mkAgent(root, 'good', { model: 'claude-sonnet-5' });
    const log = mkLog();

    expect(() => auditFleetModels(['good', 'missing'], root, log)).not.toThrow();
    expect(log.warnings).toHaveLength(1);
    expect(log.warnings[0]?.msg).toContain('config did not load');
  });
});
