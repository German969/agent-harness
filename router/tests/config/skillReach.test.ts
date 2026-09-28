// HAR-22: validate:fleet check 10. Every skill file is one the router can select, or
// is listed in NOT_ROUTER_SELECTED with a reason. Fakes test each rule; the last
// block runs the real repo, in both directions (check 5 too, since HAR-25).

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { skillReachProblems } from '../../src/config/skillReach.js';
import { NOT_ROUTER_SELECTED, resolvableSkills } from '../../src/routing/skill.js';
import type { AgentId } from '../../src/types.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('skillReachProblems', () => {
  it('is clean when every file is selectable or listed', () => {
    expect(skillReachProblems('a', ['x', 'y'], ['x'], { y: 'manual only' })).toEqual([]);
  });

  it('fails a skill file nothing selects and nothing lists', () => {
    expect(skillReachProblems('a', ['x', 'orphan'], ['x'], {})).toEqual([
      expect.stringMatching(/agents\/a\/skills\/orphan\.md is a skill the router can never select/),
    ]);
  });

  it('does not treat an inherited Object key as listed', () => {
    expect(skillReachProblems('a', ['constructor', 'toString'], [], {})).toHaveLength(2);
  });

  it('fails a listed skill with no file, one the router can select, or one with no reason', () => {
    const all = skillReachProblems('a', ['x', 'y'], ['x'], {
      gone: 'r',
      x: 'r',
      y: ' ',
    }).join('\n');
    expect(all).toMatch(/lists 'gone', which has no file/);
    expect(all).toMatch(/lists 'x', but the router can select it/);
    expect(all).toMatch(/lists 'y' with no reason/);
  });
});

describe('the real repo', () => {
  const agents = readdirSync(join(repoRoot, 'agents'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(repoRoot, 'agents', d.name, 'skills')))
    .map((d) => d.name as AgentId);

  // Check 5, the other direction: every skill the router can select has a file. It
  // lives in validate:fleet too; this copy makes ci.yml catch it as well (HAR-25).
  it('every skill the router can select has a file', () => {
    for (const agent of agents) {
      for (const skill of resolvableSkills(agent)) {
        expect(
          existsSync(join(repoRoot, 'agents', agent, 'skills', `${skill}.md`)),
          `${agent}: ${skill}`,
        ).toBe(true);
      }
    }
  });

  it('every skill file is reachable or deliberately not', () => {
    expect(agents.length).toBe(7);
    for (const agent of agents) {
      const files = readdirSync(join(repoRoot, 'agents', agent, 'skills'))
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.slice(0, -3));
      expect(
        skillReachProblems(agent, files, resolvableSkills(agent), NOT_ROUTER_SELECTED[agent] ?? {}),
      ).toEqual([]);
    }
  });
});
