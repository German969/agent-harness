// Skill resolution.
// Per router/ARCHITECTURE.md §2.2 — skill activation order:
//   1. Explicit selector in message text: "@guardian-bot llm-redteam <feature>" → llm-security
//   2. Label-based (Linear ticket labels map to skills)
//   3. Trigger-type default (e.g. PR-opened on Guardian → its multi-skill scan)
//   4. Fallback: the agent's default skill
//
// This module implements the mechanism; the agent-specific skill lists come
// from each agent's CLAUDE.md skill table. Phase 4 has a minimal built-in
// mapping; agents can extend via convention in later phases.

import type { WebhookEvent } from '../ingress/types.js';
import type { AgentId, SkillId } from '../types.js';
import { type MatchReason, isWorkTrigger } from './matchReason.js';

/** Known selectors that appear in "@<agent>-bot <selector> ..." patterns. */
const AGENT_SKILL_SELECTORS: Record<AgentId, Record<string, SkillId>> = {
  strategist: {
    draft: 'pm',
    triage: 'triage',
    research: 'researcher',
    curate: 'curator',
    status: 'pjm',
  },
  platform: {
    design: 'system-design',
    adr: 'architect',
    cost: 'finops',
    release: 'release-manager',
    incident: 'incident-response',
  },
  'builder-server': {
    contract: 'contract-design',
    migration: 'backend',
  },
  'builder-client': {
    screenshot: 'screenshots',
    a11y: 'a11y',
    prefill: 'claude-design-prefill',
  },
  guardian: {
    'threat-model': 'security',
    'llm-redteam': 'llm-security',
    'perf-profile': 'performance',
    'compliance-review': 'compliance',
    'design-system-review': 'design-system',
  },
  marketer: {
    launch: 'campaign-lead',
    campaign: 'campaign-lead',
    brief: 'creative-brief',
    benchmark: 'benchmarking',
  },
  harness: {
    survey: 'gap-analyzer',
    debug: 'misbehavior-debugger',
    create: 'agent-architect',
    tweak: 'agent-modifier',
  },
};

/**
 * Strategist founding (Phase 0) intent. Unlike the single-word selectors, its
 * natural phrasing ("kick off Phase 0", "evaluate this product doc") doesn't put
 * a keyword right after the mention, so we match these phrases anywhere in the
 * text. Without this the `founding` skill is unreachable — it has no selector and
 * isn't a default — so Phase 0 can never be triggered.
 */
const FOUNDING_INTENT =
  /\b(kick[- ]?off phase\s*0|phase[- ]?0|founding|evaluate (this|the|my|our)\s+\w*\s*product\s+doc)/i;

/**
 * Strategist "log this to memory" intent → the `memo` skill. Persisting a decision
 * to `recent-decisions.md` is a state WRITE, and the cheap Haiku model the default
 * `conversational` skill runs on confabulates writes instead of calling the tool
 * (observed: it invents a "read-only filesystem" and skips `Write`). Routing memory
 * writes to a dedicated skill lets them run on the default (Sonnet) model for
 * reliable tool use, while bare Q&A stays on Haiku. Anchored on an explicit
 * write verb + a memory/decisions target so it doesn't catch ordinary questions.
 */
const MEMO_INTENT =
  /\b(log|record|save|note|remember)\b[^.!?\n]{0,50}\b((to|in)\s+(your\s+|my\s+)?(memory|decisions)|recent[- ]?decisions?)\b/i;

/**
 * Strategist's phrase intents, in precedence order. A table rather than two
 * inline `if`s so `resolvableSkills` below reads the SAME source the resolver
 * does — a separately-maintained list of "skills this agent can reach" is exactly
 * the kind of second copy that goes stale and defeats the check it feeds.
 */
const STRATEGIST_INTENTS: ReadonlyArray<{ pattern: RegExp; skill: SkillId }> = [
  { pattern: FOUNDING_INTENT, skill: 'founding' },
  { pattern: MEMO_INTENT, skill: 'memo' },
];

/**
 * Linear label → skill, per agent (HAR-23). A label selects a skill only for the
 * agent the ticket was routed to, the same shape as AGENT_SKILL_SELECTORS.
 *
 * This map used to be flat: the first label on the ticket that appeared anywhere in
 * it picked the skill, whichever agent was handling the ticket. The router routes a
 * ticket on its first ROUTING label, so a ticket labeled `security` + `campaign`
 * went to Guardian and then started `campaign-lead`, a skill Guardian does not have;
 * one assigned to Builder-Server that also carried `prd` started `pm`. Which skill
 * ran depended on label order, and could be a skill with no file to deliver.
 *
 * Keyed by agent, a label another agent owns is simply not looked at. validate:fleet
 * check 9 fails a key that routes to a different agent (it would let that agent's
 * label pick this agent's skill again), and check 5 fails a value with no skill
 * file, since resolvableSkills reads this map.
 */
const LABEL_SKILLS: Record<AgentId, Record<string, SkillId>> = {
  strategist: {
    prd: 'pm',
    founding: 'founding',
  },
  platform: {},
  'builder-server': {},
  'builder-client': {},
  guardian: {},
  marketer: {
    campaign: 'campaign-lead',
    content: 'content-writer',
    // A modifier: routes nowhere on its own, selects benchmarking alongside a
    // Marketer routing label.
    benchmark: 'benchmarking',
  },
  harness: {
    'agent-improvement': 'agent-modifier',
    'agent-misbehavior': 'misbehavior-debugger',
    'new-agent': 'agent-architect',
    'new-skill': 'skill-author',
    'router-change': 'router-engineer',
  },
};

/**
 * Work-trigger default — the skill used when the agent is auto-fired on real
 * work with no selector/label/intent match: a PR opened (`github_auto_trigger`),
 * a ticket assigned (`linear_assignment`), or a routing-label match whose label
 * isn't in LABEL_SKILLS (`linear_label`). These are work, not questions, so they
 * route to the agent's primary work skill — never conversational. The agent's
 * CLAUDE.md fans out from here (e.g. Guardian qa → qa+security on PR-open).
 */
const WORK_DEFAULT_SKILLS: Record<AgentId, SkillId> = {
  // Strategist has no work auto-trigger and its work tickets carry LABEL_SKILLS
  // labels (prd→pm, …) that resolve before this fallback; an unlabeled assignment
  // lands on conversational, which routes/escalates — matches prior behavior.
  strategist: 'conversational',
  // Platform's Linear routing labels (adr/release/finops/…) aren't in LABEL_SKILLS,
  // so label-routed work tickets fall through to here — architect is the right work
  // default (its CLAUDE.md then picks the specific skill). A bare mention is NOT a
  // work trigger and goes to conversational (below), so a "hello" stays cheap.
  platform: 'architect',
  'builder-server': 'backend',
  'builder-client': 'frontend',
  guardian: 'qa',
  marketer: 'campaign-lead',
  harness: 'agent-modifier',
};

/**
 * Conversation default — the lightweight, cheap-model skill for a bare mention /
 * channel message / addressed-but-unmatched event (no selector, label, or intent).
 * These are questions, lookups, or routing — not work — so every agent falls back
 * here instead of loading heavy context and running a full artifact procedure on
 * the default (Sonnet) model. Each agent ships a `conversational.md` scoped to its
 * own domain, with `conversational` overridden to Haiku in its settings.json.
 */
const CONVERSATION_DEFAULT: SkillId = 'conversational';

/**
 * `github_pr_owner` — an event on a PR this agent owns: a review comment, a
 * change request, a human push to its branch, or a CI run that finished red.
 *
 * These are work, so they took WORK_DEFAULT_SKILLS: `backend` for Builder-Server.
 * That is the wrong procedure. `backend` is the full development cycle, which
 * opens by reading a ticket and planning an implementation; reacting to one review
 * comment is a different job with a different shape, and the fleet has had a skill
 * for it all along. `pr-feedback` is named as the handler in both Builders'
 * CLAUDE.md skill tables, in their SPECs ("Phase 7 — React (via `pr-feedback`
 * skill)"), and in their `only_skills` heavy-context load hooks — and the router
 * could never select it, because nothing mapped a reason to it.
 *
 * Its lesson-capture step is the reason this matters beyond tidiness: the rule for
 * appending a validated review lesson to `coding-practices.md` exists only in
 * `pr-feedback.md`. No session has ever run that skill, and the file has never
 * been written.
 *
 * Only the two agents that HAVE the skill are listed. Guardian, Harness and
 * Platform can own PRs too; they fall through to their work default, which is the
 * behaviour they have today.
 */
const PR_FEEDBACK_SKILLS: Partial<Record<AgentId, SkillId>> = {
  'builder-server': 'pr-feedback',
  'builder-client': 'pr-feedback',
};

export function resolveSkill(
  agent: AgentId,
  event: WebhookEvent,
  opts: { reason?: MatchReason } = {},
): SkillId {
  // 1. Explicit selector from message text
  const selector = extractSelector(agent, event);
  if (selector) return selector;

  // 2. Label-based (Linear only), from this agent's labels only — see LABEL_SKILLS.
  if (event.provider === 'linear') {
    const skill = labelSkillFor(agent, event);
    if (skill) return skill;
  }

  // 2b. Strategist phrase intents (matched anywhere in the text), in table order —
  //     founding before memo, since a founding session already persists its own state.
  if (agent === 'strategist') {
    const text = extractText(event);
    if (text) {
      for (const { pattern, skill } of STRATEGIST_INTENTS) {
        if (pattern.test(text)) return skill;
      }
    }
  }

  // 3. Reason-specific work skill. An event on a PR the agent owns is work, but
  //    not the SAME work as a fresh ticket — see PR_FEEDBACK_SKILLS.
  if (opts.reason === 'github_pr_owner') {
    const prSkill = PR_FEEDBACK_SKILLS[agent];
    if (prSkill) return prSkill;
  }

  // 4. Fallback split by trigger kind. A work trigger (PR opened, ticket
  //    assigned/label-routed) is real work → the agent's work default, whose
  //    CLAUDE.md fans out (e.g. Guardian qa → qa+security). A bare mention /
  //    channel message / addressed-but-unmatched event is a question → the
  //    lightweight conversational skill (cheap model, no heavy context load).
  return opts.reason && isWorkTrigger(opts.reason)
    ? WORK_DEFAULT_SKILLS[agent]
    : CONVERSATION_DEFAULT;
}

function extractSelector(agent: AgentId, event: WebhookEvent): SkillId | undefined {
  const text = extractText(event);
  if (!text) return undefined;
  const selectors = AGENT_SKILL_SELECTORS[agent];
  if (!selectors) return undefined;
  // Match either "@<handle> <selector>" (GitHub/Linear style — handle can be
  // <name>-bot, <name>-agent, or any hyphenated identifier) OR "<@USER_ID>
  // <selector>" (Slack style — payloads always carry user IDs) anywhere in text.
  for (const [selectorWord, skill] of Object.entries(selectors)) {
    const pattern = new RegExp(`(@[\\w-]+|<@[\\w-]+>)\\s+${selectorWord}\\b`, 'i');
    if (pattern.test(text)) return skill;
  }
  return undefined;
}

function extractText(event: WebhookEvent): string | undefined {
  const p = event.payload as {
    event?: unknown;
    comment?: unknown;
    issue?: unknown;
    pull_request?: unknown;
    data?: unknown;
  };

  // Slack: payload.event.text
  if (event.provider === 'slack' && typeof p.event === 'object' && p.event !== null) {
    const t = (p.event as { text?: unknown }).text;
    if (typeof t === 'string') return t;
  }

  // GitHub: comment.body / issue.body / pull_request.body
  if (event.provider === 'github') {
    const bodies = [
      (p.comment as { body?: unknown } | undefined)?.body,
      (p.issue as { body?: unknown } | undefined)?.body,
      (p.pull_request as { body?: unknown } | undefined)?.body,
    ];
    for (const b of bodies) if (typeof b === 'string') return b;
  }

  // Linear: data.body / data.description
  if (event.provider === 'linear' && typeof p.data === 'object' && p.data !== null) {
    const d = p.data as { body?: unknown; description?: unknown };
    if (typeof d.body === 'string') return d.body;
    if (typeof d.description === 'string') return d.description;
  }

  return undefined;
}

/** The skill the ticket's first label in LABEL_SKILLS[agent] selects, if any. */
function labelSkillFor(agent: AgentId, event: WebhookEvent): SkillId | undefined {
  const skills = LABEL_SKILLS[agent];
  if (!skills) return undefined;
  const p = event.payload as { data?: unknown };
  if (typeof p.data !== 'object' || p.data === null) return undefined;
  const d = p.data as { labels?: unknown };
  if (!Array.isArray(d.labels)) return undefined;
  for (const label of d.labels) {
    const name =
      typeof label === 'string'
        ? label
        : typeof label === 'object' && label !== null && 'name' in label
          ? (label as { name: unknown }).name
          : undefined;
    // hasOwn, not a plain index: a label named `constructor` used to return
    // Object.prototype.constructor, a function, as the skill.
    if (typeof name === 'string' && Object.hasOwn(skills, name)) return skills[name];
  }
  return undefined;
}

/** Linear label → skill for one agent: LABEL_SKILLS[agent]. Read by the §5 label
 *  table generator and check 9 (config/linearLabels.ts), so the table shows what the
 *  router actually selects rather than what a comment claims. */
export function labelSkills(agent: AgentId): Readonly<Record<string, SkillId>> {
  return { ...(LABEL_SKILLS[agent] ?? {}) };
}

/** The skill a label-routed ticket starts when none of its labels is in LABEL_SKILLS[agent]. */
export function workDefaultSkill(agent: AgentId): SkillId {
  return WORK_DEFAULT_SKILLS[agent];
}

/**
 * Every skill `resolveSkill` can return for `agent` — the set CI checks has a
 * file at `agents/<agent>/skills/<skill>.md`. Routing to a skill with no file
 * delivers no procedure at all, which is the gap this whole change closes; a
 * mapping that can silently point at nothing would reopen it one level up.
 *
 * Derived from the same maps the resolver reads, so it cannot drift. LABEL_SKILLS
 * is included now that it is keyed by agent (HAR-23): each entry is a skill that
 * agent can actually be handed.
 */
export function resolvableSkills(agent: AgentId): SkillId[] {
  const prFeedback = PR_FEEDBACK_SKILLS[agent];
  return [
    ...new Set<SkillId>([
      ...Object.values(AGENT_SKILL_SELECTORS[agent] ?? {}),
      ...Object.values(LABEL_SKILLS[agent] ?? {}),
      ...(prFeedback ? [prFeedback] : []),
      ...(agent === 'strategist' ? STRATEGIST_INTENTS.map((i) => i.skill) : []),
      WORK_DEFAULT_SKILLS[agent],
      CONVERSATION_DEFAULT,
    ]),
  ];
}
