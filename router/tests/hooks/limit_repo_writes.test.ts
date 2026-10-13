// HAR-9: Harness and Guardian write `dev-team` through the GitHub MCP, because the
// router mounts it read-only. Those tools commit straight to the branch they are
// given, so the real PreToolUse hooks must refuse a default branch, and Guardian's
// must keep it to its two registry files. Tested against the agents' actual
// settings.json, in both directions: a gate that never fires is the bug, and one
// that over-fires gets switched off.

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAgentConfig } from '../../src/config/agentLoader.js';
import type { HookEntry } from '../../src/config/settingsSchema.js';
import {
  limitRepoWritesHandler,
  touchedPaths,
} from '../../src/hooks/commands/limit_repo_writes.js';
import { runToolCallPhase } from '../../src/hooks/orchestrator.js';
import { getToolCallHandler, inferCommand } from '../../src/hooks/registry.js';
import { mkToolCtx } from './_rig.js';

const devTeamRoot = join(process.cwd(), '..');

function preToolUse(agent: 'harness' | 'guardian'): HookEntry[] {
  return (loadAgentConfig(agent, { devTeamRoot }).settings.hooks?.PreToolUse ?? []) as HookEntry[];
}

async function decide(agent: 'harness' | 'guardian', tool: string, input: unknown) {
  const r = await runToolCallPhase(
    preToolUse(agent),
    mkToolCtx({ agent, tool, input }),
    'PreToolUse',
  );
  return r.deny ? 'deny' : 'allow';
}

const REGISTRY = 'agents/guardian/sensitive-paths.yml';

describe('limit_repo_writes', () => {
  const HOOK = {
    tool: ['mcp__github__create_or_update_file', 'mcp__github__push_files'],
    repo: 'dev-team',
    allow_paths: [REGISTRY],
  };

  it('is inferred from its shape and registered', () => {
    expect(inferCommand(HOOK)).toBe('limit_repo_writes');
    expect(getToolCallHandler('limit_repo_writes')).toBe(limitRepoWritesHandler);
  });

  it('collects every path a write tool touches', () => {
    expect(touchedPaths({ path: 'a' })).toEqual(['a']);
    expect(touchedPaths({ files: [{ path: 'a' }, { path: 'b' }] })).toEqual(['a', 'b']);
    expect(touchedPaths({ ops: [{ op: 'move', from: 'a', to: 'b' }] })).toEqual(['a', 'b']);
    expect(touchedPaths({ from_path: 'a', to_path: 'b' })).toEqual(['a', 'b']);
  });

  it('denies a push that mixes an allowed path with any other', async () => {
    const r = await limitRepoWritesHandler(
      HOOK,
      mkToolCtx({
        tool: 'mcp__github__push_files',
        input: { repo: 'dev-team', files: [{ path: REGISTRY }, { path: 'AGENTS.md' }] },
      }),
    );
    expect(r.kind).toBe('deny');
    if (r.kind === 'deny') expect(r.message).toContain('AGENTS.md');
  });

  it('matches the repo with or without its owner, case-insensitively', async () => {
    const r = await limitRepoWritesHandler(
      HOOK,
      mkToolCtx({
        tool: 'mcp__github__create_or_update_file',
        input: { repo: 'German969/Dev-Team', path: 'PROTOCOLS.md' },
      }),
    );
    expect(r.kind).toBe('deny');
  });

  it('leaves other repositories and other tools alone', async () => {
    const other = await limitRepoWritesHandler(
      HOOK,
      mkToolCtx({
        tool: 'mcp__github__create_or_update_file',
        input: { repo: 'chatbots', path: 'tests/x.test.ts' },
      }),
    );
    const tool = await limitRepoWritesHandler(
      HOOK,
      mkToolCtx({ tool: 'mcp__github__create_branch', input: { repo: 'dev-team', branch: 'x' } }),
    );
    expect(other.kind).toBe('allow');
    expect(tool.kind).toBe('allow');
  });
});

describe("Guardian's dev-team write gate (real settings)", () => {
  it('allows its two registry files on a feature branch', async () => {
    for (const path of [REGISTRY, 'agents/guardian/perf-sensitive-paths.yml']) {
      expect(
        await decide('guardian', 'mcp__github__create_or_update_file', {
          owner: 'German969',
          repo: 'dev-team',
          path,
          branch: 'agent/guardian-bot/registry',
          content: 'x',
        }),
      ).toBe('allow');
    }
  });

  it('refuses any other dev-team path', async () => {
    expect(
      await decide('guardian', 'mcp__github__create_or_update_file', {
        owner: 'German969',
        repo: 'dev-team',
        path: 'agents/guardian/CLAUDE.md',
        branch: 'agent/guardian-bot/registry',
        content: 'x',
      }),
    ).toBe('deny');
  });

  it('refuses a default branch even for a registry file', async () => {
    expect(
      await decide('guardian', 'mcp__github__create_or_update_file', {
        owner: 'German969',
        repo: 'dev-team',
        path: REGISTRY,
        branch: 'main',
        content: 'x',
      }),
    ).toBe('deny');
  });
});

describe("Harness's GitHub write gate (real settings)", () => {
  it('allows any dev-team path on an agent branch', async () => {
    expect(
      await decide('harness', 'mcp__github__push_files', {
        owner: 'German969',
        repo: 'dev-team',
        branch: 'agent/harness-bot/HAR-9',
        files: [{ path: 'PROTOCOLS.md', content: 'x' }],
        message: 'm',
      }),
    ).toBe('allow');
  });

  it('refuses a commit to a default branch', async () => {
    for (const branch of ['main', 'master', 'staging', 'production']) {
      expect(
        await decide('harness', 'mcp__github__create_or_update_file', {
          owner: 'German969',
          repo: 'dev-team',
          path: 'PROTOCOLS.md',
          branch,
          content: 'x',
        }),
      ).toBe('deny');
    }
  });

  it('lets it branch off main', async () => {
    expect(
      await decide('harness', 'mcp__github__create_branch', {
        owner: 'German969',
        repo: 'dev-team',
        branch: 'agent/harness-bot/HAR-9',
        from_branch: 'main',
      }),
    ).toBe('allow');
  });

  it('does not mistake a branch that merely contains "main" for main', async () => {
    expect(
      await decide('harness', 'mcp__github__create_or_update_file', {
        owner: 'German969',
        repo: 'dev-team',
        path: 'PROTOCOLS.md',
        branch: 'agent/harness-bot/main-fix',
        content: 'x',
      }),
    ).toBe('allow');
  });
});
