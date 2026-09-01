import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '../../src/config/index.js';
import { linearGatedAllowed } from '../../src/runtime/sdkCall.js';

/** Minimal AgentConfig carrying only the mcp.mcpServers the gate reads. */
function cfg(linear: Record<string, unknown> | undefined): AgentConfig {
  return { mcp: { mcpServers: linear ? { linear } : {} } } as unknown as AgentConfig;
}

describe('linearGatedAllowed — human-command gate for Linear mutations', () => {
  const strategist = cfg({ type: 'sdk', gated_mutations: true });

  it('allows gated tools on an explicit human mention when the agent opts in', () => {
    expect(linearGatedAllowed(strategist, 'explicit_mention')).toBe(true);
  });

  it('denies on autonomous / work triggers even when the agent opts in', () => {
    expect(linearGatedAllowed(strategist, 'linear_assignment')).toBe(false);
    expect(linearGatedAllowed(strategist, 'github_pr_owner')).toBe(false);
    expect(linearGatedAllowed(strategist, undefined)).toBe(false);
  });

  it('denies for an agent whose linear entry does not declare gated_mutations', () => {
    expect(linearGatedAllowed(cfg({ type: 'sdk' }), 'explicit_mention')).toBe(false);
    expect(linearGatedAllowed(cfg(undefined), 'explicit_mention')).toBe(false);
  });
});
