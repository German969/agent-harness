// Guards over the REAL agents/*/mcp.json files (not fixtures).
//
// Motivation: Builder-Client shipped an active stdio server pointing at
// `npx -y @anthropic-ai/mcp-claude-preview`, a package that does not exist on npm —
// so that server never started, and every session spawned a child that could not
// succeed. It did not break those sessions (they completed normally), but it is
// dead weight, and the deploy bakes MCP binaries into the router image precisely so
// no session depends on a registry fetch at spawn time. This guard keeps that true.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const AGENTS_DIR = join(REPO_ROOT, 'agents');

type Server = { type?: string; command?: string; args?: string[] };

function agentDirs(): string[] {
  return readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Active = not disabled by the leading-underscore convention (see sdkCall.ts). */
function activeStdioServers(agent: string): Array<[string, Server]> {
  const raw = readFileSync(join(AGENTS_DIR, agent, 'mcp.json'), 'utf-8');
  const cfg = JSON.parse(raw) as { mcpServers?: Record<string, Server> };
  return Object.entries(cfg.mcpServers ?? {}).filter(
    ([name, s]) => !name.startsWith('_') && s.type === 'stdio',
  );
}

describe('real agents/*/mcp.json', () => {
  const agents = agentDirs();

  it('finds the fleet', () => {
    expect(agents.length).toBeGreaterThan(0);
  });

  // The deploy bakes MCP binaries into the router image precisely so sessions
  // never depend on a registry fetch at spawn time.
  it.each(agents)('%s declares no npx-fetched stdio MCP server', (agent) => {
    const offenders = activeStdioServers(agent)
      .filter(([, s]) => s.command === 'npx' || s.command?.endsWith('/npx'))
      .map(([name, s]) => `${name} (${s.command} ${(s.args ?? []).join(' ')})`);

    expect(offenders).toEqual([]);
  });

  it.each(agents)('%s stdio servers use an absolute command path', (agent) => {
    const relative = activeStdioServers(agent)
      .filter(([, s]) => typeof s.command === 'string' && !s.command.startsWith('/'))
      .map(([name, s]) => `${name} (${s.command})`);

    expect(relative).toEqual([]);
  });
});
