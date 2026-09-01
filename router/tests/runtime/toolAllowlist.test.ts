// `permissions.allow` becoming a real restriction.
//
// The SDK's allowedTools is a prompt-skip list ("auto-allowed without prompting…
// to restrict which tools are available, use the `tools` option instead"). The
// router never set `tools`, so every built-in was available to every agent
// regardless of config. These tests cover the derivation and, more importantly,
// what the REAL fleet configs resolve to — a stripped tool is the failure mode.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinToolsFrom } from '../../src/runtime/toolAllowlist.js';

describe('builtinToolsFrom', () => {
  it('reduces permission rules to bare tool names', () => {
    // `tools` takes names; `allow` carries argument filters. Many Bash rules are one Bash.
    expect(builtinToolsFrom(['Bash(git log:*)', 'Bash(git diff:*)', 'Read'])).toEqual([
      'Bash',
      'Read',
    ]);
  });

  it('drops MCP entries — `tools` governs built-ins only', () => {
    expect(builtinToolsFrom(['Read', 'mcp__linear__create_issue', 'mcp__github__get_*'])).toEqual([
      'Read',
    ]);
  });

  it('drops the inline `_`-prefixed comments these arrays carry', () => {
    expect(builtinToolsFrom(['_note: allow is not a restriction today', 'Read'])).toEqual(['Read']);
  });

  it('passes an unrecognised non-MCP name through rather than filtering it out', () => {
    // A hard-coded set of "known built-ins" here would silently withhold a tool
    // the day the CLI adds one — a tool vanishing without a message is the exact
    // failure this whole series has been chasing. The SDK ignores names it does
    // not know; dropping a real one breaks an agent.
    expect(builtinToolsFrom(['Read', 'SomeNewToolTheCliAdded'])).toEqual([
      'Read',
      'SomeNewToolTheCliAdded',
    ]);
  });

  it('returns undefined rather than an empty list', () => {
    // `tools: []` means "disable ALL built-in tools". An agent with a malformed or
    // MCP-only allow list must fall back to unrestricted, not to nothing.
    expect(builtinToolsFrom([])).toBeUndefined();
    expect(builtinToolsFrom(['mcp__linear__create_issue'])).toBeUndefined();
    expect(builtinToolsFrom(['_only a comment'])).toBeUndefined();
  });
});

describe('what the real fleet configs resolve to', () => {
  // The derivation being correct is not the same as the configs being complete.
  // This is the check that would have caught the pre-#37 state, where Harness had
  // Write/Edit in none of the three permission lists and would have lost the
  // ability to author the files that are its entire job.
  const agentsDir = join(process.cwd(), '..', 'agents');
  const agents = readdirSync(agentsDir).filter((n) => statSync(join(agentsDir, n)).isDirectory());

  it.each(agents)('%s keeps the tools it cannot work without', (agent) => {
    const settings = JSON.parse(readFileSync(join(agentsDir, agent, 'settings.json'), 'utf-8')) as {
      permissions: { allow: string[] };
    };
    const tools = builtinToolsFrom(settings.permissions.allow);

    expect(tools).toBeDefined();
    // Read/Grep/Glob/Bash: no agent in this fleet can do its job without them.
    for (const required of ['Read', 'Grep', 'Glob', 'Bash']) {
      expect(tools).toContain(required);
    }
    // Every agent writes something — state files at minimum, which its SessionEnd
    // hook then commits.
    expect(tools).toContain('Write');
    expect(tools).toContain('Edit');
  });

  it('never hands the SDK an MCP name in the built-in list', () => {
    for (const agent of agents) {
      const settings = JSON.parse(
        readFileSync(join(agentsDir, agent, 'settings.json'), 'utf-8'),
      ) as { permissions: { allow: string[] } };
      for (const tool of builtinToolsFrom(settings.permissions.allow) ?? []) {
        expect(tool.startsWith('mcp__')).toBe(false);
      }
    }
  });

  it('the restriction actually removes the tools #36 denies', () => {
    // Belt and braces with the fleet deny list: `tools` leaves them out of the
    // base set, `disallowedTools` removes them again. Either alone would do.
    for (const agent of agents) {
      const settings = JSON.parse(
        readFileSync(join(agentsDir, agent, 'settings.json'), 'utf-8'),
      ) as { permissions: { allow: string[] } };
      const tools = builtinToolsFrom(settings.permissions.allow) ?? [];
      for (const spawner of ['Agent', 'Workflow', 'CronCreate', 'ScheduleWakeup']) {
        expect(tools).not.toContain(spawner);
      }
    }
  });
});
