import { beforeEach, describe, expect, it } from 'vitest';
import type { WebhookEvent } from '../../src/ingress/types.js';
import {
  type Registry,
  buildRegistry,
  classify,
  findAgentByHint,
  isWorkTrigger,
} from '../../src/routing/index.js';
import type { Identity } from '../../src/routing/schema.js';
import {
  type Db,
  applyMigrations,
  createSession,
  openDb,
  updateStatus,
} from '../../src/state/index.js';

// ---------------------------------------------------------------------------
// Fixture — realistic identity set for all 7 agents
// ---------------------------------------------------------------------------
const identities: Identity[] = [
  {
    agent: 'strategist',
    continuation_timeout_days: 30,
    github: { app_slug: 'strategist-bot', app_id: 100, bot_username: 'strategist-bot[bot]' },
    linear: { agent_handle: 'strategist-bot', webhook_id: 'wh-strat', user_id: 'usr-strat' },
    slack: { app_id: 'A-strat', bot_user_id: 'U-STRAT' },
    routing: { linear_labels: ['prd', 'research'] },
  },
  {
    agent: 'guardian',
    continuation_timeout_days: 30,
    github: { app_slug: 'guardian-bot', app_id: 200, bot_username: 'guardian-bot[bot]' },
    linear: { agent_handle: 'guardian-bot', webhook_id: 'wh-guard', user_id: 'usr-guard' },
    slack: { app_id: 'A-guard', bot_user_id: 'U-GUARD' },
    routing: {
      linear_labels: ['security', 'perf'],
      github_auto_triggers: ['pull_request.opened'],
    },
  },
  {
    agent: 'marketer',
    continuation_timeout_days: 60,
    linear: { agent_handle: 'marketer-bot', webhook_id: 'wh-mkt', user_id: 'usr-mkt' },
    slack: { app_id: 'A-mkt', bot_user_id: 'U-MKT' },
    routing: { linear_labels: ['campaign', 'content'] },
  },
];

let registry: Registry;
let db: Db;

beforeEach(() => {
  registry = buildRegistry(identities);
  db = openDb({ path: ':memory:' });
  applyMigrations(db);
});

function ev(overrides: Partial<WebhookEvent>): WebhookEvent {
  return {
    provider: 'github',
    delivery_id: 'd',
    event_type: 'pull_request.opened',
    agent_hint: '',
    payload: {},
    received_at: Date.now(),
    ...overrides,
  };
}

describe('classify — explicit mention wins', () => {
  it('Slack @strategist-bot mention → strategist', () => {
    const result = classify(
      ev({
        provider: 'slack',
        event_type: 'app_mention',
        agent_hint: 'A-guard', // hint says guardian, but mention overrides
        payload: {
          event: {
            channel: 'C1',
            ts: '1.0',
            text: 'hey <@U-STRAT> draft a PRD please',
            type: 'app_mention',
          },
        },
      }),
      { registry, db },
    );
    expect(result).toMatchObject({
      route: 'agent',
      agent: 'strategist',
      match_reason: 'explicit_mention',
    });
  });

  it('GitHub @guardian-bot mention in PR comment → guardian (guardian app delivery)', () => {
    const result = classify(
      ev({
        provider: 'github',
        event_type: 'issue_comment.created',
        agent_hint: '200', // guardian's own app delivers the mention
        payload: {
          repository: { full_name: 'org/repo' },
          issue: { number: 5, pull_request: {} },
          comment: { body: '@guardian-bot review please' },
        },
      }),
      { registry, db },
    );
    expect(result).toMatchObject({
      route: 'agent',
      agent: 'guardian',
      match_reason: 'explicit_mention',
    });
  });

  it('drops another app’s duplicate delivery of a @guardian-bot mention', () => {
    // Same comment, but delivered to strategist's app (100). Guardian handles it
    // via its OWN delivery (above); this copy must be dropped, not spawn strategist.
    const result = classify(
      ev({
        provider: 'github',
        event_type: 'issue_comment.created',
        agent_hint: '100',
        payload: {
          repository: { full_name: 'org/repo' },
          issue: { number: 5, pull_request: {} },
          comment: { body: '@guardian-bot review please' },
        },
      }),
      { registry, db },
    );
    expect(result.route).toBe('unmatched');
  });
});

describe('classify — Linear assignment', () => {
  it('ticket assigned to guardian.user_id → guardian', () => {
    const result = classify(
      ev({
        provider: 'linear',
        event_type: 'Issue.update',
        agent_hint: 'wh-guard',
        payload: {
          data: {
            identifier: 'ENG-1',
            assignee: { id: 'usr-guard' },
          },
        },
      }),
      { registry, db },
    );
    expect(result).toMatchObject({
      route: 'agent',
      agent: 'guardian',
      match_reason: 'linear_assignment',
    });
  });
});

describe('classify — GitHub auto-trigger', () => {
  it('PR opened → guardian (per identity github_auto_triggers, guardian app delivery)', () => {
    const result = classify(
      ev({
        provider: 'github',
        event_type: 'pull_request.opened',
        agent_hint: '200', // guardian's own app delivers pull_request.opened
        payload: {
          repository: { full_name: 'org/repo' },
          pull_request: { number: 42, body: 'no mentions here' },
        },
      }),
      { registry, db },
    );
    expect(result).toMatchObject({
      route: 'agent',
      agent: 'guardian',
      match_reason: 'github_auto_trigger',
    });
  });

  it('drops another app’s duplicate delivery of pull_request.opened', () => {
    const result = classify(
      ev({
        provider: 'github',
        event_type: 'pull_request.opened',
        agent_hint: '100', // strategist's app also receives it — must drop
        payload: {
          repository: { full_name: 'org/repo' },
          pull_request: { number: 42, body: 'no mentions here' },
        },
      }),
      { registry, db },
    );
    expect(result.route).toBe('unmatched');
  });
});

describe('classify — GitHub PR owner (one owner per PR)', () => {
  it('unowned PR comment (no label, human-opened, no mention) → unmatched', () => {
    const result = classify(
      ev({
        provider: 'github',
        event_type: 'issue_comment.created',
        agent_hint: '200',
        payload: {
          repository: { full_name: 'org/repo' },
          issue: { number: 7, pull_request: {}, user: { login: 'a-human' }, labels: [] },
          comment: { body: 'looks good' },
        },
      }),
      { registry, db },
    );
    expect(result.route).toBe('unmatched');
  });

  it('`agent:guardian` label routes PR comment to guardian (its own delivery)', () => {
    const result = classify(
      ev({
        provider: 'github',
        event_type: 'issue_comment.created',
        agent_hint: '200',
        payload: {
          repository: { full_name: 'org/repo' },
          issue: { number: 7, pull_request: {}, labels: [{ name: 'agent:guardian' }] },
          comment: { body: 'please address the review' },
        },
      }),
      { registry, db },
    );
    expect(result).toMatchObject({
      route: 'agent',
      agent: 'guardian',
      match_reason: 'github_pr_owner',
    });
  });

  it('drops the same owned-PR comment delivered to a non-owner app', () => {
    const result = classify(
      ev({
        provider: 'github',
        event_type: 'issue_comment.created',
        agent_hint: '100', // strategist's app; owner is guardian → drop
        payload: {
          repository: { full_name: 'org/repo' },
          issue: { number: 7, pull_request: {}, labels: [{ name: 'agent:guardian' }] },
          comment: { body: 'please address the review' },
        },
      }),
      { registry, db },
    );
    expect(result.route).toBe('unmatched');
  });

  it('falls back to the agent whose app opened the PR when no label is present', () => {
    const result = classify(
      ev({
        provider: 'github',
        event_type: 'pull_request_review_comment.created',
        agent_hint: '200',
        payload: {
          repository: { full_name: 'org/repo' },
          pull_request: { number: 8, user: { login: 'guardian-bot[bot]' }, labels: [] },
          comment: { body: 'a line comment' },
        },
      }),
      { registry, db },
    );
    expect(result).toMatchObject({
      route: 'agent',
      agent: 'guardian',
      match_reason: 'github_pr_owner',
    });
  });
});

describe('classify — GitHub CI-event ownership', () => {
  // Establish ownership of PR #42 (guardian) by classifying its open event first.
  function ownPr42() {
    classify(
      ev({
        provider: 'github',
        event_type: 'pull_request.opened',
        agent_hint: '200',
        payload: {
          repository: { full_name: 'org/repo' },
          pull_request: { number: 42, user: { login: 'guardian-bot[bot]' }, labels: [] },
        },
      }),
      { registry, db },
    );
  }

  it('check_suite gated to the PR owner (owner’s own delivery proceeds)', () => {
    ownPr42();
    const result = classify(
      ev({
        provider: 'github',
        event_type: 'check_suite.completed',
        agent_hint: '200', // guardian's app delivery
        payload: {
          repository: { full_name: 'org/repo' },
          check_suite: { pull_requests: [{ number: 42 }], conclusion: 'failure' },
        },
      }),
      { registry, db },
    );
    expect(result).toMatchObject({
      route: 'agent',
      agent: 'guardian',
      match_reason: 'github_pr_owner',
    });
  });

  // A merged PR still gets a reply — Phase 8 archives the PR history — but there
  // is nothing left to build, so it must not load the work skill or lease a
  // worktree. Session 286 did Phase 8 usefully AND burned a Sonnet work session
  // on a PR that was already closed.
  it('routes a closed PR to its owner without making it a work trigger', () => {
    ownPr42();
    const result = classify(
      ev({
        provider: 'github',
        event_type: 'pull_request.closed',
        agent_hint: '200',
        payload: {
          repository: { full_name: 'org/repo' },
          pull_request: { number: 42, labels: [{ name: 'agent:guardian' }] },
        },
      }),
      { registry, db },
    );
    expect(result).toMatchObject({
      route: 'agent',
      agent: 'guardian',
      match_reason: 'github_pr_closed',
    });
    expect(isWorkTrigger('github_pr_closed')).toBe(false);
  });

  it('still treats an open PR event as work', () => {
    ownPr42();
    const result = classify(
      ev({
        provider: 'github',
        event_type: 'pull_request.synchronize',
        agent_hint: '200',
        payload: {
          repository: { full_name: 'org/repo' },
          pull_request: { number: 42, labels: [{ name: 'agent:guardian' }] },
        },
      }),
      { registry, db },
    );
    expect(result).toMatchObject({ match_reason: 'github_pr_owner' });
    expect(isWorkTrigger('github_pr_owner')).toBe(true);
  });

  it('drops a CI event delivered to a non-owner app', () => {
    ownPr42();
    const result = classify(
      ev({
        provider: 'github',
        event_type: 'check_run.completed',
        agent_hint: '100', // strategist's app; owner is guardian → drop
        payload: {
          repository: { full_name: 'org/repo' },
          check_run: { pull_requests: [{ number: 42 }], conclusion: 'failure' },
        },
      }),
      { registry, db },
    );
    expect(result.route).toBe('unmatched');
  });

  it('drops a CI event for a PR nobody here owns (no cached owner)', () => {
    const result = classify(
      ev({
        provider: 'github',
        event_type: 'workflow_run.completed',
        agent_hint: '200',
        payload: {
          repository: { full_name: 'org/repo' },
          workflow_run: { pull_requests: [{ number: 999 }], conclusion: 'failure' },
        },
      }),
      { registry, db },
    );
    expect(result).toMatchObject({ route: 'unmatched', reason: 'github_ci_unowned' });
  });

  // The cycle these prevent: the agent pushes, the push starts CI, CI wakes the
  // agent, which pushes again. Sessions 281-283 were exactly that, stopped only
  // by the chain-depth cap. A run that has not finished has nothing to act on.
  it.each(['requested', 'in_progress'])('drops workflow_run.%s outright', (action) => {
    ownPr42();
    const result = classify(
      ev({
        provider: 'github',
        event_type: `workflow_run.${action}`,
        agent_hint: '200',
        payload: {
          repository: { full_name: 'org/repo' },
          workflow_run: { pull_requests: [{ number: 42 }] },
        },
      }),
      { registry, db },
    );
    expect(result).toMatchObject({ route: 'unmatched', reason: 'github_ci_not_actionable' });
  });

  // Green CI, and the not-a-failure conclusions, are equally not work.
  it.each(['success', 'neutral', 'skipped', 'cancelled', 'stale'])(
    'drops a completed run concluding %s',
    (conclusion) => {
      ownPr42();
      const result = classify(
        ev({
          provider: 'github',
          event_type: 'check_suite.completed',
          agent_hint: '200',
          payload: {
            repository: { full_name: 'org/repo' },
            check_suite: { pull_requests: [{ number: 42 }], conclusion },
          },
        }),
        { registry, db },
      );
      expect(result).toMatchObject({ route: 'unmatched', reason: 'github_ci_not_actionable' });
    },
  );

  it.each(['failure', 'timed_out', 'action_required'])(
    'wakes the PR owner for a run concluding %s',
    (conclusion) => {
      ownPr42();
      const result = classify(
        ev({
          provider: 'github',
          event_type: 'check_suite.completed',
          agent_hint: '200',
          payload: {
            repository: { full_name: 'org/repo' },
            check_suite: { pull_requests: [{ number: 42 }], conclusion },
          },
        }),
        { registry, db },
      );
      expect(result).toMatchObject({ route: 'agent', agent: 'guardian' });
    },
  );
});

describe('classify — Linear events nobody claimed', () => {
  // The fleet shares ONE Linear webhook, so agent_hint is that webhook's id: it says
  // which secret verified the signature, not who should handle the event. Falling back
  // on it made the webhook's declaring agent the handler for every Linear event in the
  // workspace — including its own replies, which come back as Comment.create and wake
  // it again. One probe comment spawned sessions 211-222 before this was caught.
  it('an unclaimed Linear comment is dropped, not routed to the webhook declarer', () => {
    const result = classify(
      ev({
        provider: 'linear',
        event_type: 'Comment.create',
        agent_hint: 'wh-guard', // guardian declares the webhook — must NOT make it the handler
        payload: {
          data: {
            issue: { identifier: 'ENG-9' },
            body: 'a comment mentioning nobody, on a ticket with no labels',
          },
        },
      }),
      { registry, db },
    );
    expect(result).toMatchObject({ route: 'unmatched', reason: 'linear_unclaimed_event' });
  });

  it("an agent's own reply does not wake it again", () => {
    const result = classify(
      ev({
        provider: 'linear',
        event_type: 'Comment.create',
        agent_hint: 'wh-guard',
        payload: {
          data: {
            issue: { identifier: 'ENG-9' },
            // The reply footer names the agent but is not an @-mention of it.
            body: 'Here is my answer.\n\n---\n*🤖 @guardian-agent • conversational • 8s*',
          },
        },
      }),
      { registry, db },
    );
    expect(result.route).toBe('unmatched');
  });

  it('still routes an unclaimed Slack event by hint — one app per agent there', () => {
    const result = classify(
      ev({
        provider: 'slack',
        event_type: 'message',
        agent_hint: 'A-guard',
        payload: { event: { channel: 'C-unclaimed', text: 'no mention here' } },
      }),
      { registry, db },
    );
    expect(result).toMatchObject({ route: 'agent', match_reason: 'agent_hint' });
  });
});

describe('classify — Linear label routing', () => {
  it('ticket with "campaign" label → marketer', () => {
    const result = classify(
      ev({
        provider: 'linear',
        event_type: 'Issue.create',
        agent_hint: 'wh-unknown',
        payload: {
          data: { identifier: 'ENG-2', labels: [{ name: 'campaign' }] },
        },
      }),
      { registry, db },
    );
    expect(result).toMatchObject({
      route: 'agent',
      agent: 'marketer',
      match_reason: 'linear_label',
    });
  });

  // HAR-23: the ticket routes on its first ROUTING label, and the skill must come
  // from that agent's labels. A flat LABEL_SKILLS let `campaign` pick Guardian's skill.
  it.each([
    [['security', 'campaign'], 'guardian', 'security'],
    [['campaign', 'security'], 'marketer', 'campaign-lead'],
    [['perf', 'prd'], 'guardian', 'performance'],
    [['prd', 'perf'], 'strategist', 'pm'],
  ] as const)('labels %j → %s running %s', (labels, agent, skill) => {
    const result = classify(
      ev({
        provider: 'linear',
        event_type: 'Issue.update',
        agent_hint: 'wh-unknown',
        payload: { data: { identifier: 'ENG-4', labels: labels.map((name) => ({ name })) } },
      }),
      { registry, db },
    );
    expect(result).toMatchObject({ route: 'agent', agent, skill, match_reason: 'linear_label' });
  });

  it('a ticket assigned to an agent ignores another agent’s skill labels', () => {
    const result = classify(
      ev({
        provider: 'linear',
        event_type: 'Issue.update',
        agent_hint: 'wh-unknown',
        payload: {
          data: {
            identifier: 'ENG-5',
            assignee: { id: 'usr-guard' },
            labels: [{ name: 'prd' }, { name: 'campaign' }],
          },
        },
      }),
      { registry, db },
    );
    expect(result).toMatchObject({
      agent: 'guardian',
      skill: 'qa',
      match_reason: 'linear_assignment',
    });
  });

  it('mention wins over label', () => {
    const result = classify(
      ev({
        provider: 'linear',
        event_type: 'Comment.create',
        agent_hint: 'wh-unknown',
        payload: {
          data: {
            issue: { identifier: 'ENG-3' },
            body: 'hey @guardian-bot check this',
            labels: [{ name: 'campaign' }], // marketer label but guardian is mentioned
          },
        },
      }),
      { registry, db },
    );
    expect(result).toMatchObject({ agent: 'guardian', match_reason: 'explicit_mention' });
  });
});

describe('classify — unclaimed non-PR GitHub events are dropped', () => {
  // GitHub fans one event out to every installed app. Falling back to "the
  // delivering app's agent handles its own delivery" therefore wakes EVERY agent
  // once dedup is keyed per-agent (which the mention + PR-owner gates require).
  // Nobody claimed these, so nobody runs.
  it('non-PR event with no mention and no auto-trigger → unmatched', () => {
    const result = classify(
      ev({
        provider: 'github',
        event_type: 'ping',
        agent_hint: '200',
        payload: { zen: 'wisdom', repository: { full_name: 'org/repo' } },
      }),
      { registry, db },
    );
    expect(result).toEqual({ route: 'unmatched', reason: 'github_unclaimed_event' });
  });

  // The regression that motivated this: one issues.opened reached three agents.
  it('issues.opened wakes NO agent, whichever app delivered it', () => {
    const payload = {
      action: 'opened',
      issue: { number: 9, body: 'Tracking issue for IRS-46. No mention here.' },
      repository: { full_name: 'org/repo' },
    };
    // Every app in the registry, i.e. every copy GitHub actually fans out.
    const appIds = [...registry.githubByAppId.keys()];
    expect(appIds.length).toBeGreaterThan(1);

    for (const appId of appIds) {
      const result = classify(
        ev({ provider: 'github', event_type: 'issues.opened', agent_hint: appId, payload }),
        { registry, db },
      );
      expect(result).toEqual({ route: 'unmatched', reason: 'github_unclaimed_event' });
    }
  });

  // The escape hatch: an agent that wants an event type declares it, and step 2
  // resolves + gates it to exactly that agent.
  it('an auto-triggered event still reaches its one declared agent', () => {
    const declared = [...registry.githubAutoTriggers.entries()][0];
    expect(declared).toBeDefined();
    const [eventType, owner] = declared as [string, string];

    const deliveredToOwner = registry.byAgent.get(owner as never)?.github?.app_id;
    const result = classify(
      ev({
        provider: 'github',
        event_type: eventType,
        agent_hint: String(deliveredToOwner),
        payload: {
          action: 'opened',
          pull_request: { number: 1 },
          repository: { full_name: 'o/r' },
        },
      }),
      { registry, db },
    );
    expect(result).toMatchObject({ route: 'agent', agent: owner });
  });
});

describe('classify — unmatched', () => {
  it('no signals + no hint match → unmatched', () => {
    const result = classify(
      ev({
        provider: 'github',
        event_type: 'ping',
        agent_hint: 'nonexistent',
        payload: {},
      }),
      { registry, db },
    );
    expect(result).toEqual({ route: 'unmatched', reason: 'no_matching_agent' });
  });
});

describe('classify — skill resolution', () => {
  it('resolves selector skill from message text', () => {
    const result = classify(
      ev({
        provider: 'slack',
        event_type: 'app_mention',
        agent_hint: 'A-guard',
        payload: {
          event: {
            channel: 'C1',
            ts: '1.0',
            text: '<@U-GUARD> llm-redteam the summary bot',
          },
        },
      }),
      { registry, db },
    );
    expect(result).toMatchObject({ agent: 'guardian', skill: 'llm-security' });
  });

  it('falls back to the lightweight conversational default (not pm)', () => {
    const result = classify(
      ev({
        provider: 'slack',
        event_type: 'app_mention',
        agent_hint: 'A-strat',
        payload: {
          event: { channel: 'C1', ts: '1.0', text: '<@U-STRAT> hey' },
        },
      }),
      { registry, db },
    );
    expect(result).toMatchObject({ agent: 'strategist', skill: 'conversational' });
  });

  it('routes Strategist "kick off Phase 0" to the founding skill', () => {
    const result = classify(
      ev({
        provider: 'slack',
        event_type: 'app_mention',
        agent_hint: 'A-strat',
        payload: {
          event: { channel: 'C1', ts: '1.0', text: '<@U-STRAT> kick off Phase 0 for chatbots' },
        },
      }),
      { registry, db },
    );
    expect(result).toMatchObject({ agent: 'strategist', skill: 'founding' });
  });

  it('routes "evaluate this product doc" to founding', () => {
    const result = classify(
      ev({
        provider: 'slack',
        event_type: 'app_mention',
        agent_hint: 'A-strat',
        payload: {
          event: {
            channel: 'C1',
            ts: '1.0',
            text: '<@U-STRAT> can you evaluate this product doc?',
          },
        },
      }),
      { registry, db },
    );
    expect(result).toMatchObject({ agent: 'strategist', skill: 'founding' });
  });

  it('routes "log this decision to your memory" to the memo skill', () => {
    const result = classify(
      ev({
        provider: 'slack',
        event_type: 'app_mention',
        agent_hint: 'A-strat',
        payload: {
          event: {
            channel: 'C1',
            ts: '1.0',
            text: '<@U-STRAT> log a decision to your memory: we shipped state persistence',
          },
        },
      }),
      { registry, db },
    );
    expect(result).toMatchObject({ agent: 'strategist', skill: 'memo' });
  });

  it('does NOT route an ordinary question mentioning memory to memo', () => {
    const result = classify(
      ev({
        provider: 'slack',
        event_type: 'app_mention',
        agent_hint: 'A-strat',
        payload: {
          event: {
            channel: 'C1',
            ts: '1.0',
            text: '<@U-STRAT> how much memory does the server use?',
          },
        },
      }),
      { registry, db },
    );
    expect(result).toMatchObject({ agent: 'strategist', skill: 'conversational' });
  });
});

describe('classify — continuation', () => {
  it('returns { mode: "new" } when no prior session', () => {
    const result = classify(
      ev({
        provider: 'slack',
        event_type: 'app_mention',
        agent_hint: 'A-strat',
        payload: {
          event: { channel: 'C-new', ts: '1.0', text: '<@U-STRAT> hi' },
        },
      }),
      { registry, db },
    );
    if (result.route === 'unmatched') expect.fail('expected agent route');
    else expect(result.continuation).toEqual({ mode: 'new' });
  });

  it('returns { mode: "continue" } when a prior session in the same thread exists', () => {
    // Seed a completed session with the same thread_key that the next event will produce.
    const id = createSession(db, {
      agent: 'strategist',
      thread_key: 'slack:C-x/1.0',
      status: 'pending',
      triggered_by: 'webhook:slack',
      trigger_payload: {},
    });
    updateStatus(db, id, 'completed', {
      ended_at: Date.now() - 60_000,
      claude_session_id: 'msg_prev_123',
    });

    const result = classify(
      ev({
        provider: 'slack',
        event_type: 'app_mention',
        agent_hint: 'A-strat',
        payload: {
          event: { channel: 'C-x', ts: '1.1', thread_ts: '1.0', text: '<@U-STRAT> follow-up' },
        },
      }),
      { registry, db },
    );
    if (result.route === 'unmatched') expect.fail('expected agent route');
    else
      expect(result.continuation).toEqual({
        mode: 'continue',
        claude_session_id: 'msg_prev_123',
        parent_row_id: id,
      });
  });
});

describe('classify — secret-lookup integration', () => {
  it('registry-based agent detection matches ingress agent-hint layer', () => {
    // This verifies the Registry + classifier + secret-lookup all use the same
    // agent-hint namespace (App ID for GitHub etc.). If they drift, ingress
    // returns 404 but classification would still work — a smell we want caught.
    //
    // Probed directly rather than through classify(): the classifier no longer
    // has an agent_hint fallback for GitHub (unclaimed non-PR events are dropped),
    // so a classification result can no longer stand in for hint resolution.
    expect(findAgentByHint(registry, 'github', '100')).toBe('strategist');
    expect(findAgentByHint(registry, 'github', '200')).toBe('guardian');
    expect(findAgentByHint(registry, 'github', 'nonexistent')).toBeUndefined();
  });
});
