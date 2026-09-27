// Reads the real repo into the `RoutingFacts` linearLabels.ts needs. Kept apart from
// linearLabels.ts so that module stays pure and testable with fakes.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadIdentities } from '../routing/loader.js';
import {
  labelSkill,
  labelSkillKeys,
  resolvableSkills,
  workDefaultSkill,
} from '../routing/skill.js';
import type { AgentId } from '../types.js';
import { AGENT_ORDER, type RoutingFacts } from './linearLabels.js';

export function loadRoutingFacts(repoRoot: string): { facts: RoutingFacts; errors: string[] } {
  const { identities, errors } = loadIdentities(join(repoRoot, 'identities'));
  const rank = (agent: string) => {
    const i = (AGENT_ORDER as readonly string[]).indexOf(agent);
    return i === -1 ? AGENT_ORDER.length : i;
  };
  const sorted = [...identities].sort(
    (a, b) => rank(a.agent) - rank(b.agent) || a.agent.localeCompare(b.agent),
  );
  const declared = new Map<string, readonly string[]>(
    sorted.map((id) => [id.agent, id.routing?.linear_labels ?? []]),
  );
  const agentSkills = (agent: string): ReadonlySet<string> => {
    const dir = join(repoRoot, 'agents', agent, 'skills');
    const files = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith('.md'))
          .map((f) => f.slice(0, -3))
      : [];
    return new Set([...resolvableSkills(agent as AgentId), ...files]);
  };
  return {
    facts: {
      declared,
      labelSkill,
      labelSkillKeys,
      workDefaultSkill: (agent) => workDefaultSkill(agent as AgentId),
      agentSkills,
    },
    errors: errors.map((e) => `identities/${e.file}: ${e.reason}`),
  };
}
