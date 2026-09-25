// Classifier — turns a verified WebhookEvent into a Classification.
// Per router/ARCHITECTURE.md §1.2 (Classify — trigger → agent + skill + continuation).

import type { WebhookEvent } from '../ingress/types.js';
import {
  type Db,
  type SessionRow,
  findContinuation as findContinuationDb,
  getPrOwner,
  recordPrOwner,
} from '../state/index.js';
import type { AgentId, SkillId } from '../types.js';
import { agentFromBotLogin } from './authorship.js';
import { type MatchReason, isWorkTrigger } from './matchReason.js';
import { extractMentionedAgent } from './mention.js';
import type { Registry } from './registry.js';
import { resolveSkill } from './skill.js';
import { buildThreadKey } from './threadKey.js';

export type ContinuationDecision =
  | { mode: 'new' }
  | { mode: 'continue'; claude_session_id: string; parent_row_id: number };

export type Classification =
  | {
      route: 'agent';
      agent: AgentId;
      skill: SkillId;
      thread_key: string | undefined;
      continuation: ContinuationDecision;
      match_reason: MatchReason;
    }
  | {
      route: 'unmatched';
      reason: string;
    };

// Re-exported so every existing importer keeps its path; both moved to
// matchReason.ts, which skill.ts now reads too.
export { type MatchReason, isWorkTrigger };

const DAY_MS = 24 * 60 * 60 * 1000;

/** PR-owner label convention: an `agent:<name>` label designates the owner agent.
 *  `<name>` is the agent id (`agent:guardian`) or its Linear `agent_handle`
 *  (`agent:guardian-bot`) — see `ownerFromLabel`. */
const OWNER_LABEL_PREFIX = 'agent:';

export type ClassifyDeps = {
  registry: Registry;
  db: Db;
  now?: () => number;
};

export function classify(event: WebhookEvent, deps: ClassifyDeps): Classification {
  // GitHub uses owner-aware routing. Every installed GitHub App receives its OWN
  // delivery of the same PR event, so without a gate every agent reacts to every
  // comment/review (the multi-agent PR cascade). classifyGithub picks ONE intended
  // agent per event and drops the other apps' duplicate deliveries.
  if (event.provider === 'github') {
    return classifyGithub(event, deps);
  }

  // 1. Explicit mention wins (Slack / Linear).
  const mentioned = extractMentionedAgent(deps.registry, event);
  if (mentioned) {
    return buildAgentClassification(event, deps, mentioned, 'explicit_mention');
  }

  // 2. Linear: assignment to agent's user_id / agent_id.
  if (event.provider === 'linear') {
    const assignedAgent = extractLinearAssignee(deps.registry, event);
    if (assignedAgent) {
      return buildAgentClassification(event, deps, assignedAgent, 'linear_assignment');
    }
  }

  // 3. Linear label routing.
  if (event.provider === 'linear') {
    const labelAgent = extractLinearLabelAgent(deps.registry, event);
    if (labelAgent) {
      return buildAgentClassification(event, deps, labelAgent, 'linear_label');
    }
  }

  // 4. Slack channel-default routing.
  if (event.provider === 'slack') {
    const channelAgent = extractSlackChannelAgent(deps.registry, event);
    if (channelAgent) {
      return buildAgentClassification(event, deps, channelAgent, 'slack_channel_default');
    }
  }

  // 5. Fallback: the agent_hint from ingress. This holds only where the hint identifies
  //    ONE agent — Slack, where every agent is its own app and the hint is that app's id.
  //
  //    It does NOT hold for Linear. The fleet shares one OAuth app and therefore ONE
  //    webhook, so `agent_hint` is that single webhook's id: it says which secret verified
  //    the signature, not who should handle the event. Falling back on it made Strategist
  //    the handler for every Linear event in the workspace — including its OWN comments,
  //    which arrive back as Comment.create and wake it again. That loop is not theoretical:
  //    one probe comment on IRS-46 spawned sessions 211-222, escalating from the
  //    `conversational` skill into `founding` at $0.34 a session.
  //
  //    Linear events nobody claimed by mention, assignment, or label are dropped. This is
  //    the same correction step 4 of classifyGithub already makes for GitHub's fan-out.
  if (event.provider !== 'linear') {
    const hintAgent = findAgentByAgentHint(deps.registry, event);
    if (hintAgent) {
      return buildAgentClassification(event, deps, hintAgent, 'agent_hint');
    }
  }

  if (event.provider === 'linear') {
    return { route: 'unmatched', reason: 'linear_unclaimed_event' };
  }

  return { route: 'unmatched', reason: 'no_matching_agent' };
}

/**
 * GitHub classification with single-owner-per-PR enforcement.
 *
 * The problem: each agent is its own GitHub App, all installed on the target repo,
 * and GitHub fans out every webhook to every installed app. A PR comment therefore
 * arrives once per app; the old agent_hint fallback then spawned one session PER
 * agent — every agent reacting to every comment/review.
 *
 * The fix: compute the single intended agent for the event, then proceed ONLY if
 * this delivery belongs to that agent (`deliveredTo === target`); otherwise drop it
 * as a duplicate. Precedence: explicit @-mention → configured auto-trigger (e.g.
 * Guardian on pull_request.opened) → the PR OWNER (an `agent:<name>` label, else the
 * agent whose app opened the PR). Non-PR events that nobody claimed are dropped.
 */
function classifyGithub(event: WebhookEvent, deps: ClassifyDeps): Classification {
  const reg = deps.registry;
  const deliveredTo = reg.githubByAppId.get(event.agent_hint);
  if (!deliveredTo) return { route: 'unmatched', reason: 'no_matching_agent' };

  // Keep the PR→owner cache current from any PR event that carries owner metadata
  // (labels + author). CI events, which don't, read this cache below.
  maybeRecordPrOwner(reg, deps.db, event);

  // 1. Explicit @-mention — any agent can be pulled into any PR by name.
  const mentioned = extractMentionedAgent(reg, event);
  if (mentioned) return gateGithub(event, deps, mentioned, deliveredTo, 'explicit_mention');

  // 2. Configured auto-trigger (e.g. Guardian reviews on pull_request.opened).
  const autoAgent = reg.githubAutoTriggers.get(event.event_type);
  if (autoAgent) return gateGithub(event, deps, autoAgent, deliveredTo, 'github_auto_trigger');

  // 3. Any other PR-scoped event (comments, reviews, pushes) → the PR owner only.
  //    This is what stops the cascade: a comment reaches every app, but only the
  //    owner's delivery is processed.
  if (isGithubPrEvent(event)) {
    const owner = resolvePrOwner(reg, event);
    if (!owner) return { route: 'unmatched', reason: 'github_pr_unowned' };
    // A merged or closed PR still deserves a reply — the Builder's own cycle ends
    // with Phase 8 (archive the PR history, clear active-prs.md), and session 286
    // did exactly that usefully. But it is NOT work: there is nothing left to
    // build, so loading the full work skill and leasing a worktree buys nothing
    // and costs a Sonnet session. `github_pr_closed` is deliberately absent from
    // the work-trigger set (matchReason.ts), so it takes the cheap conversational skill with
    // no checkout.
    const reason =
      event.event_type === 'pull_request.closed' ? 'github_pr_closed' : 'github_pr_owner';
    return gateGithub(event, deps, owner, deliveredTo, reason);
  }

  // 3b. CI events (check_suite / check_run / workflow_run) reference the PR only by
  //     number — no labels or author to resolve an owner from. Gate them to the
  //     owner cached from that PR's earlier events; drop when ownership is unknown
  //     (a PR nobody here owns) instead of cascading to every installed app.
  //
  //     Only a FINISHED, FAILING run is work. `requested` and `in_progress` say
  //     nothing an agent can act on, and a green run needs no action either — but
  //     each of them used to open a full `backend` session, and the agent's own
  //     push is what starts CI, so the agent kept re-waking itself. Sessions
  //     281-283 were exactly that: CI from a push waking Builder-Server, which
  //     pushed again, three times over, stopped only by the chain-depth cap.
  if (isGithubCiEvent(event)) {
    if (!isActionableCiEvent(event)) {
      return { route: 'unmatched', reason: 'github_ci_not_actionable' };
    }
    const owner = resolveCiOwner(deps.db, event);
    if (!owner) return { route: 'unmatched', reason: 'github_ci_unowned' };
    return gateGithub(event, deps, owner, deliveredTo, 'github_pr_owner');
  }

  // 4. Anything else — a non-PR, non-CI event that nobody claimed. Drop it.
  //
  //    This used to fall back to `agent_hint`: the delivering app's agent handled
  //    its own delivery. That was only ever safe by accident. GitHub fans every
  //    event out to every installed app under ONE delivery GUID, and the old
  //    delivery_id-keyed dedup collapsed the fan-out to whichever copy arrived
  //    first, so exactly one (arbitrary) agent woke. Keying dedup on
  //    (delivery_id, agent) — necessary for the mention + PR-owner gates below to
  //    see their own app's copy — removed that accident, and a single
  //    `issues.opened` then woke every installed agent at once.
  //
  //    Dropping is also the honest behavior: an issue nobody mentioned an agent in
  //    is not addressed to anyone. An agent that genuinely wants an event type
  //    declares it in `routing.github_auto_triggers`, which step 2 above resolves
  //    to a single agent and gates like everything else.
  return { route: 'unmatched', reason: 'github_unclaimed_event' };
}

/** Proceed only if this delivery is for the intended agent; else drop the duplicate
 *  (the same event was, or will be, delivered to the intended agent's own app). */
function gateGithub(
  event: WebhookEvent,
  deps: ClassifyDeps,
  target: AgentId,
  deliveredTo: AgentId,
  reason: MatchReason,
): Classification {
  if (target === deliveredTo) return buildAgentClassification(event, deps, target, reason);
  return { route: 'unmatched', reason: 'github_duplicate_delivery' };
}

/** Is this a PR-scoped event? All `pull_request*` events, plus `issue_comment` when
 *  the issue is actually a PR (GitHub delivers PR comments as issue_comment). */
function isGithubPrEvent(event: WebhookEvent): boolean {
  const t = event.event_type;
  if (t.startsWith('pull_request')) return true;
  if (t.startsWith('issue_comment')) {
    const p = event.payload as { issue?: { pull_request?: unknown } };
    return typeof p.issue === 'object' && p.issue !== null && p.issue.pull_request !== undefined;
  }
  return false;
}

/** The PR owner: an `agent:<name>` label if present (human-visible + overridable),
 *  else the agent whose GitHub App opened the PR (`<app-slug>[bot]` author). */
function resolvePrOwner(reg: Registry, event: WebhookEvent): AgentId | undefined {
  const { labels, authorLogin } = githubPrMeta(event);
  for (const name of labels) {
    const agent = ownerFromLabel(reg, name);
    if (agent) return agent;
  }
  if (authorLogin) {
    const opener = agentFromBotLogin(reg, authorLogin);
    if (opener) return opener;
  }
  return undefined;
}

/**
 * The agent an `agent:<name>` label names, if any.
 *
 * Accepts the bare agent id AND the agent's `linear.agent_handle`, because the labels
 * the agents' own PR hooks apply are the handle form — `agent:harness-bot`,
 * `agent:guardian-bot`, `agent:client-bot` — and until HAR-13 not one of them
 * resolved: the lookup only knew bare ids, so every configured owner label was
 * silently ignored and routing fell through to the App-author fallback.
 *
 * The handle is matched whole rather than by stripping `-bot`: Builder-Client's
 * handle is `client-bot`, and stripping gives `client`, which is not an agent.
 */
export function ownerFromLabel(reg: Registry, label: string): AgentId | undefined {
  if (!label.startsWith(OWNER_LABEL_PREFIX)) return undefined;
  const name = label.slice(OWNER_LABEL_PREFIX.length).trim();
  if (name === '') return undefined;
  if (reg.byAgent.has(name as AgentId)) return name as AgentId;
  for (const id of reg.identities) {
    if (id.linear?.agent_handle === name) return id.agent;
  }
  return undefined;
}

/** Record the resolved owner for a PR event so CI events can be gated to it later.
 *  A no-op unless the event is PR-scoped, carries a repo + PR number, and resolves
 *  to a known owner. Runs regardless of how the event itself is routed. */
function maybeRecordPrOwner(reg: Registry, db: Db, event: WebhookEvent): void {
  if (!isGithubPrEvent(event)) return;
  const ref = githubPrRef(event);
  if (!ref) return;
  const owner = resolvePrOwner(reg, event);
  if (!owner) return;
  recordPrOwner(db, { repo: ref.repo, number: ref.number, agent: owner });
}

/** CI-class events that reference a PR only by number (no labels/author to resolve
 *  an owner from directly). */
function isGithubCiEvent(event: WebhookEvent): boolean {
  const name = event.event_type.split('.')[0];
  return name === 'check_suite' || name === 'check_run' || name === 'workflow_run';
}

/**
 * Whether a CI event carries something an agent can act on: a run that has
 * FINISHED and did not pass.
 *
 * The action half matters as much as the conclusion. GitHub fires `requested`
 * and `in_progress` for every run, and those describe a run that has not
 * produced a result yet — there is nothing to read and nothing to fix. Waking a
 * work skill for them is not just waste, it is a cycle: the agent pushes, the
 * push starts CI, CI wakes the agent.
 *
 * `neutral`, `skipped`, `cancelled` and `stale` are also not failures. Only
 * `failure`, `timed_out` and `action_required` describe a broken run. An absent
 * conclusion means the run has not finished, whatever the action says.
 */
function isActionableCiEvent(event: WebhookEvent): boolean {
  const action = event.event_type.split('.')[1];
  if (action !== 'completed') return false;
  const p = event.payload as {
    check_suite?: { conclusion?: unknown };
    check_run?: { conclusion?: unknown };
    workflow_run?: { conclusion?: unknown };
  };
  const conclusion =
    p.check_suite?.conclusion ?? p.check_run?.conclusion ?? p.workflow_run?.conclusion;
  return conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'action_required';
}

/** Resolve the owner of a CI event via the pr_owner cache: the first referenced PR
 *  that has a recorded owner wins. */
function resolveCiOwner(db: Db, event: WebhookEvent): AgentId | undefined {
  const refs = githubCiPrRefs(event);
  for (const ref of refs) {
    const owner = getPrOwner(db, ref.repo, ref.number);
    if (owner) return owner;
  }
  return undefined;
}

/** Repo full name + PR number for a PR-scoped event (`pull_request` node on
 *  PR/review events, `issue` node on PR comment events). */
function githubPrRef(event: WebhookEvent): { repo: string; number: number } | undefined {
  const p = event.payload as {
    repository?: { full_name?: unknown };
    pull_request?: { number?: unknown };
    issue?: { number?: unknown };
  };
  const repo = p.repository?.full_name;
  const num = p.pull_request?.number ?? p.issue?.number;
  if (typeof repo !== 'string' || typeof num !== 'number') return undefined;
  return { repo, number: num };
}

/** Repo full name + referenced PR numbers for a CI event. check_suite/check_run/
 *  workflow_run each carry a `pull_requests[]` array of minimal PR refs. */
function githubCiPrRefs(event: WebhookEvent): Array<{ repo: string; number: number }> {
  const p = event.payload as {
    repository?: { full_name?: unknown };
    check_suite?: { pull_requests?: unknown };
    check_run?: { pull_requests?: unknown };
    workflow_run?: { pull_requests?: unknown };
  };
  const repo = p.repository?.full_name;
  if (typeof repo !== 'string') return [];
  const prs =
    p.check_suite?.pull_requests ?? p.check_run?.pull_requests ?? p.workflow_run?.pull_requests;
  if (!Array.isArray(prs)) return [];
  const refs: Array<{ repo: string; number: number }> = [];
  for (const pr of prs) {
    const n = (pr as { number?: unknown })?.number;
    if (typeof n === 'number') refs.push({ repo, number: n });
  }
  return refs;
}

/** Pull label names + author login off the PR node (`pull_request` on PR/review
 *  events, `issue` on PR comment events). */
function githubPrMeta(event: WebhookEvent): { labels: string[]; authorLogin: string | undefined } {
  const p = event.payload as {
    pull_request?: { labels?: unknown; user?: { login?: unknown } };
    issue?: { labels?: unknown; user?: { login?: unknown } };
  };
  const node = p.pull_request ?? p.issue;
  const labels: string[] = [];
  if (node && Array.isArray(node.labels)) {
    for (const l of node.labels) {
      if (typeof l === 'string') labels.push(l);
      else if (l && typeof l === 'object' && 'name' in l) {
        const n = (l as { name: unknown }).name;
        if (typeof n === 'string') labels.push(n);
      }
    }
  }
  const login = node?.user?.login;
  return { labels, authorLogin: typeof login === 'string' ? login : undefined };
}

function buildAgentClassification(
  event: WebhookEvent,
  deps: ClassifyDeps,
  agent: AgentId,
  reason: MatchReason,
): Classification {
  const skill = resolveSkill(agent, event, { reason });
  const thread_key = buildThreadKey(event);
  const continuation = decideContinuation(event, deps, agent, thread_key);
  return { route: 'agent', agent, skill, thread_key, continuation, match_reason: reason };
}

function decideContinuation(
  event: WebhookEvent,
  deps: ClassifyDeps,
  agent: AgentId,
  thread_key: string | undefined,
): ContinuationDecision {
  if (!thread_key) return { mode: 'new' };
  const identity = deps.registry.byAgent.get(agent);
  const timeoutDays = identity?.continuation_timeout_days ?? 30;
  const now = deps.now ? deps.now() : Date.now();
  const withinMs = timeoutDays * DAY_MS;
  // findContinuationDb uses Date.now() internally — we need to pass an adjusted window.
  // For now: pass withinMs (the caller's "now" is captured inside the query via
  // Date.now() - withinMs, which is fine because we accept a tiny drift in tests).
  void now;
  const prior: SessionRow | undefined = findContinuationDb(deps.db, thread_key, withinMs);
  if (!prior || !prior.claude_session_id) return { mode: 'new' };
  return {
    mode: 'continue',
    claude_session_id: prior.claude_session_id,
    parent_row_id: prior.id,
  };
}

function extractLinearAssignee(reg: Registry, event: WebhookEvent): AgentId | undefined {
  const p = event.payload as { data?: unknown };
  if (typeof p.data !== 'object' || p.data === null) return undefined;
  const d = p.data as { assignee?: unknown; assigneeId?: unknown };
  const assignee = d.assignee as { id?: unknown } | undefined;
  const assigneeId =
    typeof assignee?.id === 'string'
      ? assignee.id
      : typeof d.assigneeId === 'string'
        ? d.assigneeId
        : undefined;
  if (!assigneeId) return undefined;
  return reg.linearByUserId.get(assigneeId);
}

function extractLinearLabelAgent(reg: Registry, event: WebhookEvent): AgentId | undefined {
  const p = event.payload as { data?: unknown };
  if (typeof p.data !== 'object' || p.data === null) return undefined;
  const d = p.data as { labels?: unknown };
  if (!Array.isArray(d.labels)) return undefined;
  for (const label of d.labels) {
    let name: string | undefined;
    if (typeof label === 'string') name = label;
    else if (typeof label === 'object' && label !== null && 'name' in label) {
      const n = (label as { name: unknown }).name;
      if (typeof n === 'string') name = n;
    }
    if (name) {
      const agent = reg.labelToAgent.get(name);
      if (agent) return agent;
    }
  }
  return undefined;
}

function extractSlackChannelAgent(reg: Registry, event: WebhookEvent): AgentId | undefined {
  const p = event.payload as { event?: unknown };
  if (typeof p.event !== 'object' || p.event === null) return undefined;
  const ev = p.event as { channel?: unknown; channel_name?: unknown };
  // Channel-default routing keys use channel NAMES (e.g. '#security'), but Slack
  // payloads carry channel IDs. If the payload has channel_name, use it directly;
  // otherwise the router can't map ID → name without a Slack API call. For now
  // we rely on channel_name when present and fall through if missing.
  const name = typeof ev.channel_name === 'string' ? `#${ev.channel_name}` : undefined;
  if (!name) return undefined;
  return reg.slackChannelDefault.get(name);
}

function findAgentByAgentHint(reg: Registry, event: WebhookEvent): AgentId | undefined {
  switch (event.provider) {
    case 'github':
      return reg.githubByAppId.get(event.agent_hint);
    case 'linear':
      return reg.linearByWebhookId.get(event.agent_hint);
    case 'slack':
      return reg.slackByAppId.get(event.agent_hint);
  }
}
