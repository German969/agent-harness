import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentConfigError,
  clearAgentConfigCache,
  loadAgentConfig,
} from '../../src/config/index.js';

let root: string;

function seedAgent(
  agent: string,
  overrides: {
    claudeMd?: string;
    settings?: object;
    mcp?: object;
    skills?: Record<string, string>;
  } = {},
): void {
  const dir = join(root, 'agents', agent);
  mkdirSync(join(dir, 'skills'), { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), overrides.claudeMd ?? `# ${agent}\n`, 'utf-8');
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify(
      overrides.settings ?? {
        model: 'claude-sonnet-4-7',
        costCap: { perJobCostUsd: 5, monthlyCostUsd: 100 },
        permissions: {},
        writeScope: {},
      },
    ),
    'utf-8',
  );
  writeFileSync(
    join(dir, 'mcp.json'),
    JSON.stringify(
      overrides.mcp ?? {
        mcpServers: {},
      },
    ),
    'utf-8',
  );
  const skills = overrides.skills ?? { default: '# default skill\n' };
  for (const [name, body] of Object.entries(skills)) {
    writeFileSync(join(dir, 'skills', `${name}.md`), body, 'utf-8');
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'router-agentloader-test-'));
  clearAgentConfigCache();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  clearAgentConfigCache();
});

describe('loadAgentConfig', () => {
  it('loads a well-formed agent bundle', () => {
    seedAgent('strategist');
    const cfg = loadAgentConfig('strategist', { devTeamRoot: root });
    expect(cfg.agent).toBe('strategist');
    expect(cfg.claudeMd).toContain('strategist');
    expect(cfg.settings.model).toBe('claude-sonnet-4-7');
    expect(cfg.mcp.mcpServers).toEqual({});
    expect(cfg.skills.get('default')).toContain('default skill');
  });

  it('caches the parsed config (mtime unchanged → same instance)', () => {
    seedAgent('strategist');
    const first = loadAgentConfig('strategist', { devTeamRoot: root });
    const second = loadAgentConfig('strategist', { devTeamRoot: root });
    expect(second).toBe(first); // reference equality — cache returned
  });

  it('invalidates the cache when CLAUDE.md changes', async () => {
    seedAgent('strategist');
    const first = loadAgentConfig('strategist', { devTeamRoot: root });
    // Wait 10ms and re-write to bump mtime.
    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(join(root, 'agents/strategist/CLAUDE.md'), '# UPDATED\n', 'utf-8');
    const second = loadAgentConfig('strategist', { devTeamRoot: root });
    expect(second).not.toBe(first);
    expect(second.claudeMd).toContain('UPDATED');
  });

  it('invalidates when a skill file is added', async () => {
    seedAgent('strategist');
    const first = loadAgentConfig('strategist', { devTeamRoot: root });
    expect(first.skills.size).toBe(1);
    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(join(root, 'agents/strategist/skills/new-skill.md'), '# new\n', 'utf-8');
    const second = loadAgentConfig('strategist', { devTeamRoot: root });
    expect(second.skills.size).toBe(2);
    expect(second.skills.has('new-skill')).toBe(true);
  });

  it('invalidates when a skill file is removed', async () => {
    seedAgent('strategist', { skills: { a: 'a', b: 'b' } });
    const first = loadAgentConfig('strategist', { devTeamRoot: root });
    expect(first.skills.size).toBe(2);
    await new Promise((r) => setTimeout(r, 10));
    rmSync(join(root, 'agents/strategist/skills/a.md'));
    const second = loadAgentConfig('strategist', { devTeamRoot: root });
    expect(second.skills.size).toBe(1);
    expect(second.skills.has('a')).toBe(false);
  });

  it('throws AgentConfigError on missing CLAUDE.md', () => {
    // Seed only mcp + settings; omit CLAUDE.md
    const dir = join(root, 'agents/strategist');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), '{}', 'utf-8');
    writeFileSync(join(dir, 'mcp.json'), '{"mcpServers":{}}', 'utf-8');

    expect(() => loadAgentConfig('strategist', { devTeamRoot: root })).toThrow(AgentConfigError);
  });

  it('throws AgentConfigError with a descriptive reason on bad JSON', () => {
    const dir = join(root, 'agents/strategist');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'CLAUDE.md'), '# x', 'utf-8');
    writeFileSync(join(dir, 'settings.json'), 'not json at all', 'utf-8');
    writeFileSync(join(dir, 'mcp.json'), '{"mcpServers":{}}', 'utf-8');

    try {
      loadAgentConfig('strategist', { devTeamRoot: root });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentConfigError);
      const e = err as AgentConfigError;
      expect(e.file).toBe('settings.json');
      expect(e.reason).toMatch(/invalid JSON/);
    }
  });

  it('throws AgentConfigError with a descriptive reason on schema violation', () => {
    seedAgent('strategist', {
      settings: {
        // missing required `model` field
        costCap: { perJobCostUsd: 1, monthlyCostUsd: 10 },
        permissions: {},
        writeScope: {},
      },
    });

    try {
      loadAgentConfig('strategist', { devTeamRoot: root });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentConfigError);
      const e = err as AgentConfigError;
      expect(e.file).toBe('settings.json');
      expect(e.reason).toMatch(/schema validation failed/);
    }
  });

  it('tolerates missing skills/ directory', () => {
    // Manually seed CLAUDE.md + settings.json + mcp.json but NO skills dir.
    const dir = join(root, 'agents/strategist');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'CLAUDE.md'), '# x', 'utf-8');
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        model: 'x',
        costCap: { perJobCostUsd: 1, monthlyCostUsd: 10 },
        permissions: {},
        writeScope: {},
      }),
      'utf-8',
    );
    writeFileSync(join(dir, 'mcp.json'), '{"mcpServers":{}}', 'utf-8');

    const cfg = loadAgentConfig('strategist', { devTeamRoot: root });
    expect(cfg.skills.size).toBe(0);
  });

  it('loads all 7 real agents from the actual dev-team repo', () => {
    // Derived from this test file's location (router/tests/config/) so it works
    // on any checkout, not just one contributor's machine.
    const devTeamRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    for (const agent of [
      'strategist',
      'platform',
      'builder-server',
      'builder-client',
      'guardian',
      'marketer',
      'harness',
    ] as const) {
      const cfg = loadAgentConfig(agent, { devTeamRoot });
      expect(cfg.claudeMd.length).toBeGreaterThan(100);
      expect(cfg.settings.model).toMatch(/^claude-/);
      expect(cfg.skills.size).toBeGreaterThan(0);
    }
  });

  it('opts the right agents into the in-process git-data MCP (and only those)', () => {
    const devTeamRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const hasGitData = (agent: string): boolean => {
      const servers = loadAgentConfig(agent as never, { devTeamRoot }).mcp.mcpServers;
      const entry = servers.github_gitdata as { type?: unknown } | undefined;
      return entry?.type === 'sdk';
    };
    for (const agent of ['strategist', 'harness', 'builder-server', 'builder-client']) {
      expect(hasGitData(agent), `${agent} should have git-data`).toBe(true);
    }
    for (const agent of ['platform', 'guardian', 'marketer']) {
      expect(hasGitData(agent), `${agent} should NOT have git-data`).toBe(false);
    }
  });

  it('opts Strategist into the in-process linear MCP (not the deprecated stdio server)', () => {
    const devTeamRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const servers = loadAgentConfig('strategist', { devTeamRoot }).mcp.mcpServers;
    expect((servers.linear as { type?: unknown } | undefined)?.type).toBe('sdk');
    // The disabled `_linear` stdio placeholder must be gone.
    expect(servers._linear).toBeUndefined();
  });
});
