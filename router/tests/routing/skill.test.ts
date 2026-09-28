import { describe, expect, it } from 'vitest';
import type { WebhookEvent } from '../../src/ingress/types.js';
import { labelSkills, resolvableSkills, resolveSkill } from '../../src/routing/skill.js';

/** Minimal Slack event carrying `text` (where selectors/mentions are read from). */
function slack(text: string): WebhookEvent {
  return {
    provider: 'slack',
    delivery_id: 'd1',
    event_type: 'app_mention',
    agent_hint: 'U0BOT',
    payload: { event: { text } },
    received_at: 0,
  };
}

describe('resolveSkill — conversational vs work default', () => {
  it('routes a bare mention (no work trigger) to the conversational skill', () => {
    for (const agent of [
      'platform',
      'guardian',
      'builder-server',
      'builder-client',
      'marketer',
      'harness',
    ] as const) {
      expect(resolveSkill(agent, slack('<@U0BOT> hello'))).toBe('conversational');
    }
  });

  it("routes a work auto-trigger to the agent's work default, not conversational", () => {
    const cases = {
      platform: 'architect',
      guardian: 'qa',
      'builder-server': 'backend',
      'builder-client': 'frontend',
      marketer: 'campaign-lead',
      harness: 'agent-modifier',
    } as const;
    for (const [agent, skill] of Object.entries(cases)) {
      expect(
        resolveSkill(agent as keyof typeof cases, slack('please review'), {
          reason: 'linear_assignment',
        }),
      ).toBe(skill);
    }
  });

  it('an explicit selector still wins over both defaults', () => {
    // Platform `adr` selector → architect even without a work trigger…
    expect(resolveSkill('platform', slack('<@U0BOT> adr export pattern'))).toBe('architect');
    // …and Guardian `threat-model` → security even on a bare mention.
    expect(resolveSkill('guardian', slack('<@U0BOT> threat-model the API'))).toBe('security');
  });

  it('strategist keeps its phrase intents and conversational default', () => {
    expect(resolveSkill('strategist', slack('<@U0BOT> what tech are we using?'))).toBe(
      'conversational',
    );
    expect(resolveSkill('strategist', slack('<@U0BOT> kick off phase 0'))).toBe('founding');
    // An unlabeled work assignment falls back to conversational (route/escalate).
    expect(resolveSkill('strategist', slack('do the thing'), { reason: 'linear_assignment' })).toBe(
      'conversational',
    );
  });
});

describe('resolveSkill — an event on a PR the agent owns', () => {
  // The gap this closes: `pr-feedback` is named as the handler in both Builders'
  // CLAUDE.md, SPEC and load-hook `only_skills`, and the router could never select
  // it. PR comments took `backend` — the full development cycle — and the
  // lesson-capture step that writes coding-practices.md never ran.
  it('routes both Builders to pr-feedback, not their work default', () => {
    expect(resolveSkill('builder-server', slack('please fix'), { reason: 'github_pr_owner' })).toBe(
      'pr-feedback',
    );
    expect(resolveSkill('builder-client', slack('please fix'), { reason: 'github_pr_owner' })).toBe(
      'pr-feedback',
    );
  });

  it('leaves agents without the skill on their work default', () => {
    // Guardian, Harness and Platform own PRs too. Mapping them to a skill file
    // they do not have would deliver no procedure at all — worse than today.
    expect(resolveSkill('guardian', slack('please fix'), { reason: 'github_pr_owner' })).toBe('qa');
    expect(resolveSkill('harness', slack('please fix'), { reason: 'github_pr_owner' })).toBe(
      'agent-modifier',
    );
    expect(resolveSkill('platform', slack('please fix'), { reason: 'github_pr_owner' })).toBe(
      'architect',
    );
  });

  it('a fresh PR (github_auto_trigger) is NOT feedback', () => {
    // Guardian reviewing a newly opened PR is a first review, not a reaction to
    // one — its work default is right, and would be even if it had the skill.
    expect(resolveSkill('guardian', slack('opened'), { reason: 'github_auto_trigger' })).toBe('qa');
    expect(resolveSkill('builder-server', slack('opened'), { reason: 'github_auto_trigger' })).toBe(
      'backend',
    );
  });

  it('a closed PR stays conversational', () => {
    // github_pr_closed is deliberately not a work trigger: nothing left to build,
    // so no worktree and the cheap skill. PR-feedback must not hijack it.
    expect(resolveSkill('builder-server', slack('merged'), { reason: 'github_pr_closed' })).toBe(
      'conversational',
    );
  });

  it('an explicit selector still wins over the PR-feedback mapping', () => {
    expect(
      resolveSkill('builder-server', slack('@server-agent migration add index'), {
        reason: 'github_pr_owner',
      }),
    ).toBe('backend');
  });
});

/** A Linear issue event carrying `labels`, in the order given. */
function linear(labels: string[], asObjects = true): WebhookEvent {
  return {
    provider: 'linear',
    delivery_id: 'd1',
    event_type: 'Issue.update',
    agent_hint: 'wh',
    payload: {
      data: { identifier: 'ENG-1', labels: asObjects ? labels.map((name) => ({ name })) : labels },
    },
    received_at: 0,
  };
}

/** Every order of `labels`. */
function orders(labels: string[]): string[][] {
  if (labels.length <= 1) return [labels];
  return labels.flatMap((l, i) =>
    orders([...labels.slice(0, i), ...labels.slice(i + 1)]).map((rest) => [l, ...rest]),
  );
}

describe('resolveSkill — Linear labels select only the routed agent’s skills (HAR-23)', () => {
  // LABEL_SKILLS was one flat map: the ticket's first label found anywhere in it
  // picked the skill, whichever agent had the ticket. A Guardian ticket that also
  // carried `campaign` started campaign-lead.
  it.each([
    // [agent, labels, expected skill]
    ['guardian', ['security', 'campaign'], 'qa'],
    ['guardian', ['security', 'prd', 'router-change'], 'qa'],
    ['builder-server', ['backend', 'prd'], 'backend'],
    ['platform', ['devops', 'new-agent'], 'architect'],
    ['marketer', ['campaign', 'prd'], 'campaign-lead'],
    ['strategist', ['prd', 'campaign', 'content'], 'pm'],
    ['harness', ['router-change', 'prd'], 'router-engineer'],
  ] as const)('%s with %j → %s, in every label order', (agent, labels, skill) => {
    for (const order of orders([...labels])) {
      for (const asObjects of [true, false]) {
        expect(
          resolveSkill(agent, linear(order, asObjects), { reason: 'linear_label' }),
          order.join(','),
        ).toBe(skill);
      }
    }
  });

  it('the first of the agent’s own labels still wins among several', () => {
    expect(
      resolveSkill('marketer', linear(['content', 'campaign']), { reason: 'linear_label' }),
    ).toBe('content-writer');
    expect(
      resolveSkill('marketer', linear(['campaign', 'content']), { reason: 'linear_label' }),
    ).toBe('campaign-lead');
  });

  it('a modifier selects only for its agent', () => {
    expect(
      resolveSkill('marketer', linear(['growth', 'benchmark']), { reason: 'linear_label' }),
    ).toBe('benchmarking');
    expect(
      resolveSkill('guardian', linear(['security', 'benchmark']), { reason: 'linear_label' }),
    ).toBe('qa');
  });

  it('never returns a skill outside what the agent can resolve, for any agent and label', () => {
    const agents = [
      'strategist',
      'platform',
      'builder-server',
      'builder-client',
      'guardian',
      'marketer',
      'harness',
    ] as const;
    const allLabelKeys = [...new Set(agents.flatMap((a) => Object.keys(labelSkills(a))))];
    expect(allLabelKeys.length).toBeGreaterThanOrEqual(10);
    for (const agent of agents) {
      const allowed = new Set(resolvableSkills(agent));
      for (const label of allLabelKeys) {
        const skill = resolveSkill(agent, linear([label]), { reason: 'linear_label' });
        expect(allowed.has(skill), `${agent} + ${label} → ${skill}`).toBe(true);
      }
    }
  });

  it('ignores inherited Object keys as labels', () => {
    for (const label of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(resolveSkill('guardian', linear([label]), { reason: 'linear_label' })).toBe('qa');
    }
  });
});
