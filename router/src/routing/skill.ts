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

/** Linear label → skill (checked when the ticket carries the label). */
const LABEL_SKILLS: Record<string, SkillId> = {
  prd: 'pm',
  founding: 'founding',
  campaign: 'campaign-lead',
  content: 'content-writer',
  benchmark: 'benchmarking',
  'agent-improvement': 'agent-modifier',
  'agent-misbehavior': 'misbehavior-debugger',
  'new-agent': 'agent-architect',
  'new-skill': 'skill-author',
  'router-change': 'router-engineer',
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

export function resolveSkill(
  agent: AgentId,
  event: WebhookEvent,
  opts: { workTrigger?: boolean } = {},
): SkillId {
  // 1. Explicit selector from message text
  const selector = extractSelector(agent, event);
  if (selector) return selector;

  // 2. Label-based (Linear only)
  if (event.provider === 'linear') {
    const label = extractFirstMatchingLabel(event);
    if (label && LABEL_SKILLS[label]) return LABEL_SKILLS[label] as SkillId;
  }

  // 2b. Strategist phrase intents (matched anywhere in the text). Founding is
  //     checked before memo — a founding session already persists its own state.
  if (agent === 'strategist') {
    const text = extractText(event);
    if (text && FOUNDING_INTENT.test(text)) return 'founding';
    if (text && MEMO_INTENT.test(text)) return 'memo';
  }

  // 3. Fallback split by trigger kind. A work auto-trigger (PR opened, ticket
  //    assigned/label-routed) is real work → the agent's work default, whose
  //    CLAUDE.md fans out (e.g. Guardian qa → qa+security). A bare mention /
  //    channel message / addressed-but-unmatched event is a question → the
  //    lightweight conversational skill (cheap model, no heavy context load).
  return opts.workTrigger ? WORK_DEFAULT_SKILLS[agent] : CONVERSATION_DEFAULT;
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

function extractFirstMatchingLabel(event: WebhookEvent): string | undefined {
  const p = event.payload as { data?: unknown };
  if (typeof p.data !== 'object' || p.data === null) return undefined;
  const d = p.data as { labels?: unknown };
  if (!Array.isArray(d.labels)) return undefined;
  for (const label of d.labels) {
    if (typeof label === 'string' && LABEL_SKILLS[label]) return label;
    if (typeof label === 'object' && label !== null && 'name' in label) {
      const name = (label as { name: unknown }).name;
      if (typeof name === 'string' && LABEL_SKILLS[name]) return name;
    }
  }
  return undefined;
}
