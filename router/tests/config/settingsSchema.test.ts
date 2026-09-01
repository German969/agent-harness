import { describe, expect, it } from 'vitest';
import {
  AgentSettingsSchema,
  McpConfigSchema,
  activeServers,
  resolveModel,
} from '../../src/config/index.js';

describe('AgentSettingsSchema', () => {
  it('accepts a minimal valid config', () => {
    const parsed = AgentSettingsSchema.parse({
      model: 'claude-sonnet-4-7',
      costCap: { perJobCostUsd: 5, monthlyCostUsd: 100 },
      permissions: {},
      writeScope: {},
    });
    expect(parsed.model).toBe('claude-sonnet-4-7');
    expect(parsed.max_turns).toBe(30); // default
    expect(parsed.costCap.warnAtPercent).toBe(80); // default
    expect(parsed.costCap.onCapReached).toBe('refuse_session'); // default
    expect(parsed.permissions.allow).toEqual([]);
    expect(parsed.hooks.SessionStart).toEqual([]);
  });

  it('accepts thinking + hooks + costCap details', () => {
    const parsed = AgentSettingsSchema.parse({
      model: 'claude-sonnet-4-7',
      thinking: { type: 'enabled', budget_tokens: 4000 },
      max_turns: 40,
      costCap: {
        perJobCostUsd: 10,
        monthlyCostUsd: 200,
        warnAtPercent: 90,
        alertChannel: '#agents-alerts',
        onCapReached: 'refuse_session',
      },
      permissions: {
        allow: ['Read', 'Write'],
        ask: ['git push:*'],
        deny: ['rm -rf:*'],
      },
      writeScope: {
        allowedPaths: ['dev-team/**'],
        deniedPaths: ['<target-project>/**'],
      },
      hooks: {
        SessionStart: [{ command: 'load', paths: ['some/path.md'] }],
        PreToolUse: [{ command: 'block_if_path_matches', paths: ['foo'] }],
      },
    });
    expect(parsed.thinking?.budget_tokens).toBe(4000);
    expect(parsed.hooks.SessionStart).toHaveLength(1);
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
    expect(parsed.hooks.SessionEnd).toEqual([]); // default
  });

  it('accepts modelOverrides with skill-specific model routing', () => {
    const parsed = AgentSettingsSchema.parse({
      model: 'claude-sonnet-5',
      modelOverrides: {
        pjm: 'claude-haiku-4',
        curator: 'claude-haiku-4',
        benchmarking: 'claude-haiku-4',
      },
      costCap: { perJobCostUsd: 5, monthlyCostUsd: 100 },
      permissions: {},
      writeScope: {},
    });
    expect(parsed.model).toBe('claude-sonnet-5');
    expect(parsed.modelOverrides?.pjm).toBe('claude-haiku-4');
    expect(parsed.modelOverrides?.curator).toBe('claude-haiku-4');
  });

  it('defaults modelOverrides to empty object', () => {
    const parsed = AgentSettingsSchema.parse({
      model: 'x',
      costCap: { perJobCostUsd: 1, monthlyCostUsd: 10 },
      permissions: {},
      writeScope: {},
    });
    expect(parsed.modelOverrides).toEqual({});
  });

  it('rejects missing model', () => {
    expect(() =>
      AgentSettingsSchema.parse({
        costCap: { perJobCostUsd: 1, monthlyCostUsd: 10 },
        permissions: {},
        writeScope: {},
      }),
    ).toThrow();
  });

  it('rejects invalid onCapReached enum', () => {
    expect(() =>
      AgentSettingsSchema.parse({
        model: 'x',
        costCap: { perJobCostUsd: 1, monthlyCostUsd: 10, onCapReached: 'garbage' },
        permissions: {},
        writeScope: {},
      }),
    ).toThrow();
  });

  it('preserves _comment fields (passthrough)', () => {
    const parsed = AgentSettingsSchema.parse({
      _comment: 'a top-level comment',
      model: 'x',
      costCap: { _comment: 'cost cap comment', perJobCostUsd: 1, monthlyCostUsd: 10 },
      permissions: {},
      writeScope: { _comment: 'ws comment' },
    });
    expect(parsed._comment).toBe('a top-level comment');
    expect(parsed.costCap._comment).toBe('cost cap comment');
    expect(parsed.writeScope._comment).toBe('ws comment');
  });
});

describe('resolveModel', () => {
  it('returns the default model when no skill is specified', () => {
    const settings = AgentSettingsSchema.parse({
      model: 'claude-sonnet-5',
      modelOverrides: { curator: 'claude-haiku-4' },
      costCap: { perJobCostUsd: 1, monthlyCostUsd: 10 },
      permissions: {},
      writeScope: {},
    });
    expect(resolveModel(settings)).toBe('claude-sonnet-5');
  });

  it('returns the override model when skill matches', () => {
    const settings = AgentSettingsSchema.parse({
      model: 'claude-sonnet-5',
      modelOverrides: { curator: 'claude-haiku-4', pjm: 'claude-haiku-4' },
      costCap: { perJobCostUsd: 1, monthlyCostUsd: 10 },
      permissions: {},
      writeScope: {},
    });
    expect(resolveModel(settings, 'curator')).toBe('claude-haiku-4');
    expect(resolveModel(settings, 'pjm')).toBe('claude-haiku-4');
  });

  it('returns the default model when skill does not have an override', () => {
    const settings = AgentSettingsSchema.parse({
      model: 'claude-sonnet-5',
      modelOverrides: { curator: 'claude-haiku-4' },
      costCap: { perJobCostUsd: 1, monthlyCostUsd: 10 },
      permissions: {},
      writeScope: {},
    });
    expect(resolveModel(settings, 'pm')).toBe('claude-sonnet-5');
  });

  it('returns the default model when modelOverrides is empty', () => {
    const settings = AgentSettingsSchema.parse({
      model: 'claude-sonnet-5',
      costCap: { perJobCostUsd: 1, monthlyCostUsd: 10 },
      permissions: {},
      writeScope: {},
    });
    expect(resolveModel(settings, 'curator')).toBe('claude-sonnet-5');
  });
});

describe('McpConfigSchema + activeServers', () => {
  it('parses an mcp.json with real servers + placeholder entries', () => {
    const cfg = McpConfigSchema.parse({
      mcpServers: {
        linear: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-linear'],
          env: { LINEAR_API_KEY: '${LINEAR_TOKEN}' },
        },
        _placeholder: {
          _TBD_in_phase_6: true,
          type: 'stdio',
          command: 'x',
        },
      },
    });
    const active = activeServers(cfg);
    expect(active.size).toBe(1);
    expect(active.has('linear')).toBe(true);
    expect(active.has('_placeholder')).toBe(false); // underscore-prefix filtered
  });

  it('gates servers by skill via only_skills', () => {
    const cfg = McpConfigSchema.parse({
      mcpServers: {
        linear: { type: 'stdio', command: 'x', args: [], env: {} }, // no gate → always
        github: {
          type: 'stdio',
          command: 'x',
          args: [],
          env: {},
          only_skills: ['pm', 'founding'],
        },
      },
    });
    // conversational: only the ungated server boots
    const conv = activeServers(cfg, 'conversational');
    expect(conv.has('linear')).toBe(true);
    expect(conv.has('github')).toBe(false);
    // pm: both boot
    const pm = activeServers(cfg, 'pm');
    expect(pm.has('github')).toBe(true);
    // no skill given: gated server is withheld (only_skills requires a match)
    const none = activeServers(cfg);
    expect(none.has('github')).toBe(false);
    expect(none.has('linear')).toBe(true);
  });

  it('filters out malformed server entries silently', () => {
    const cfg = McpConfigSchema.parse({
      mcpServers: {
        good: { type: 'stdio', command: 'x', args: [], env: {} },
        malformed: { type: 'stdio' /* missing command */ },
      },
    });
    const active = activeServers(cfg);
    expect(active.has('good')).toBe(true);
    expect(active.has('malformed')).toBe(false);
  });

  it('preserves passthrough top-level _comment / _future_mcp_candidates', () => {
    const cfg = McpConfigSchema.parse({
      _comment: 'doc',
      _future_mcp_candidates: { note: 'later' },
      mcpServers: {},
    });
    expect(cfg._comment).toBe('doc');
    expect(cfg._future_mcp_candidates).toEqual({ note: 'later' });
  });
});
