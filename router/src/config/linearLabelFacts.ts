// Reads the real repo into the `RoutingFacts` linearLabels.ts needs. Kept apart from
// linearLabels.ts so that module stays pure and testable with fakes.

import { join } from 'node:path';
import { loadIdentities } from '../routing/loader.js';
import { labelSkills, workDefaultSkill } from '../routing/skill.js';
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
  // Every agent in the fleet order, plus any identity outside it, so LABEL_SKILLS
  // entries for an agent are checked even if its identity file failed to load.
  const agents = [...new Set<string>([...AGENT_ORDER, ...sorted.map((id) => id.agent)])];
  const skillMaps = new Map<string, ReadonlyMap<string, string>>(
    agents.map((agent) => [agent, new Map(Object.entries(labelSkills(agent as AgentId)))]),
  );
  return {
    facts: {
      declared,
      labelSkills: skillMaps,
      workDefaultSkill: (agent) => workDefaultSkill(agent as AgentId),
    },
    errors: errors.map((e) => `identities/${e.file}: ${e.reason}`),
  };
}
