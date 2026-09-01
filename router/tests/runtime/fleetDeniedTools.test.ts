// The fleet-wide tool denials.
//
// `permissions.deny` is the only permission field that restricts anything:
// `permissions.allow` becomes the SDK's allowedTools, which the SDK's own docs
// describe as "auto-allowed without prompting… to restrict which tools are
// available, use the `tools` option instead". The router never sets `tools`, and
// its canUseTool allows whatever no PreToolUse hook denies — so a built-in no
// agent config mentions is available to every agent.

import { describe, expect, it } from 'vitest';
import { FLEET_DENIED_TOOLS, effectiveDeniedTools } from '../../src/runtime/fleetDeniedTools.js';

describe('fleet-wide denied tools', () => {
  it('denies the tools that start work the router cannot see', () => {
    // Agent and Workflow spawn execution that is not a session, so it is invisible
    // to `sessions`, to `agent_chain` and to MAX_CHAIN_DEPTH — the loop guard two
    // PRs went into hardening does not see a subagent at all.
    expect(FLEET_DENIED_TOOLS).toContain('Agent');
    expect(FLEET_DENIED_TOOLS).toContain('Workflow');
    // Scheduling belongs to scheduler/schedules.yml, which is reviewed, default-off
    // and phase-gated. An agent scheduling itself answers to none of that.
    expect(FLEET_DENIED_TOOLS).toContain('CronCreate');
    expect(FLEET_DENIED_TOOLS).toContain('ScheduleWakeup');
    expect(FLEET_DENIED_TOOLS).toContain('RemoteTrigger');
    // Checkouts are leased by the workspace manager, which owns the rows the
    // pruner reads; one made outside that is unowned and never reclaimed.
    expect(FLEET_DENIED_TOOLS).toContain('EnterWorktree');
  });

  it('does not deny the tools agents actually work with', () => {
    // The list is about work the router cannot see, not about capability. Denying
    // any of these would break every agent at once.
    for (const tool of ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch']) {
      expect(FLEET_DENIED_TOOLS).not.toContain(tool);
    }
  });

  it('prepends the fleet list to the agent’s own denials', () => {
    const result = effectiveDeniedTools(['Bash(terraform apply:*)']);
    expect(result).toContain('Agent');
    expect(result).toContain('Bash(terraform apply:*)');
    // Fleet-wide first: an agent config cannot get in front of it.
    expect(result.indexOf('Agent')).toBeLessThan(result.indexOf('Bash(terraform apply:*)'));
  });

  it('de-duplicates when an agent lists one of them too', () => {
    const result = effectiveDeniedTools(['Agent', 'NotebookEdit']);
    expect(result.filter((t) => t === 'Agent')).toHaveLength(1);
    expect(result).toContain('NotebookEdit');
  });

  it('works for an agent with no denials of its own', () => {
    expect(effectiveDeniedTools([])).toEqual([...FLEET_DENIED_TOOLS]);
  });
});
