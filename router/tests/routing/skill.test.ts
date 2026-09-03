import { describe, expect, it } from 'vitest';
import type { WebhookEvent } from '../../src/ingress/types.js';
import { resolveSkill } from '../../src/routing/skill.js';

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
