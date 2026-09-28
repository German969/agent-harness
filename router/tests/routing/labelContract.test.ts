// HAR-22: the skill each Linear routing label starts, written out by hand so a
// wrong entry in LABEL_SKILLS fails here rather than agreeing with itself. Every
// routing label an identity file declares must appear, so adding one forces a
// decision about which skill it starts. The expected skill is the one the label's
// comment in identities/<agent>.yml names; `(default)` means the work default.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { WebhookEvent } from '../../src/ingress/types.js';
import { loadIdentities } from '../../src/routing/index.js';
import { resolveSkill } from '../../src/routing/skill.js';
import type { AgentId } from '../../src/types.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const EXPECTED: Record<AgentId, Record<string, string>> = {
  strategist: {
    prd: 'pm',
    'scope-question': 'ba',
    'support-feedback': 'triage',
    research: 'researcher',
    'status-question': 'pjm',
    curate: 'curator',
    'design-prefill': 'design-prefill',
    founding: 'founding',
  },
  platform: {
    arch: 'architect',
    adr: 'architect',
    'system-design': 'system-design',
    release: 'release-manager',
    finops: 'finops',
    incident: 'incident-response',
    devops: 'devops',
    'cost-signoff': 'finops',
  },
  'builder-server': {
    backend: 'backend',
    api: 'backend',
    'needs-contract': 'contract-design',
    ai: 'ai-specialist',
    'data-engineer': 'data-engineer',
    migration: 'backend',
    'server-bot': 'backend',
  },
  'builder-client': {
    frontend: 'frontend',
    design: 'frontend',
    mobile: 'mobile',
    a11y: 'a11y',
    screenshot: 'screenshots',
    'needs-design': 'claude-design-prefill',
    'client-bot': 'frontend',
  },
  guardian: {
    security: 'security',
    qa: 'qa',
    perf: 'performance',
    compliance: 'compliance',
    'llm-security': 'llm-security',
    'legal-review': 'compliance',
    'threat-model': 'security',
    'guardian-bot': 'qa',
  },
  marketer: {
    campaign: 'campaign-lead',
    content: 'content-writer',
    social: 'social-community',
    email: 'email-lifecycle',
    pr: 'pr-brand-steward',
    brand: 'pr-brand-steward',
    growth: 'growth-analyst',
    'competitive-intel': 'benchmarking',
    'marketing-asset': 'creative-brief',
    'marketer-bot': 'campaign-lead',
  },
  harness: {
    harness: 'agent-modifier',
    'agent-improvement': 'agent-modifier',
    'agent-misbehavior': 'misbehavior-debugger',
    meta: 'agent-modifier',
    'gap-analysis': 'gap-analyzer',
    'new-agent': 'agent-architect',
    'new-skill': 'skill-author',
    'router-change': 'router-engineer',
    'harness-bot': 'agent-modifier',
  },
};

function linear(label: string): WebhookEvent {
  return {
    provider: 'linear',
    delivery_id: 'd',
    event_type: 'Issue.update',
    agent_hint: 'wh',
    payload: { data: { identifier: 'ENG-1', labels: [{ name: label }] } },
    received_at: 0,
  };
}

describe('the Linear label → skill contract', () => {
  const { identities, errors } = loadIdentities(join(repoRoot, 'identities'));

  it('covers exactly the routing labels each identity declares', () => {
    expect(errors).toEqual([]);
    expect(identities).toHaveLength(7);
    for (const id of identities) {
      expect(Object.keys(EXPECTED[id.agent] ?? {}).sort(), id.agent).toEqual(
        [...(id.routing?.linear_labels ?? [])].sort(),
      );
    }
  });

  it.each(
    Object.entries(EXPECTED).flatMap(([agent, labels]) =>
      Object.entries(labels).map(([label, skill]) => [agent, label, skill] as const),
    ),
  )('%s + %s → %s', (agent, label, skill) => {
    expect(resolveSkill(agent as AgentId, linear(label), { reason: 'linear_label' })).toBe(skill);
  });
});
