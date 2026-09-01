// Was this event authored by one of OUR agents, or by a human?
//
// The loop guard (consumer/chainGuard.ts) needs this to decide whether a session
// extends an agent→agent chain or starts a fresh human-driven one. ARCHITECTURE.md
// §3.1 calls it "human intervention": a chain only counts hops that no person
// interrupted, so a human replying in a long thread must reset the count rather
// than eventually silencing the agent.
//
// Each provider needs its own answer because each names authors differently.

import type { WebhookEvent } from '../ingress/types.js';
import { looksLikeOurFooter } from '../reply/footer.js';
import type { AgentId } from '../types.js';
import type { Registry } from './registry.js';

/** Map a bot author login (`<x>[bot]`) to the agent whose app slug or bot username is `<x>`. */
export function agentFromBotLogin(reg: Registry, login: string): AgentId | undefined {
  const base = login.replace(/\[bot\]$/, '');
  for (const id of reg.identities) {
    const g = id.github;
    if (!g) continue;
    if (g.app_slug === base) return id.agent;
    if (g.bot_username.replace(/\[bot\]$/, '') === base) return id.agent;
  }
  return undefined;
}

/**
 * True when this event was produced by an agent rather than a person.
 *
 * Deliberately conservative: an unrecognised author counts as human. Being wrong
 * that way costs one extra hop of chain depth before the cap bites; being wrong
 * the other way silences an agent mid-conversation with a person.
 */
export function isAgentAuthoredEvent(registry: Registry, event: WebhookEvent): boolean {
  switch (event.provider) {
    case 'github':
      return isGithubAgentAuthored(registry, event.payload);
    case 'slack':
      return isSlackAgentAuthored(registry, event.payload);
    case 'linear':
      return isLinearAgentAuthored(event.payload);
    default:
      return false;
  }
}

/** GitHub names the author outright. Only the fleet's own apps count — a
 *  third-party bot (CI, Dependabot) is not an agent in a coordination chain. */
function isGithubAgentAuthored(registry: Registry, payload: unknown): boolean {
  const sender = (payload as { sender?: { login?: unknown } } | undefined)?.sender;
  const login = sender?.login;
  if (typeof login !== 'string') return false;
  return agentFromBotLogin(registry, login) !== undefined;
}

/** Slack stamps `bot_id` on anything an app posted, and every agent's own
 *  `bot_user_id` is declared on its identity. */
function isSlackAgentAuthored(registry: Registry, payload: unknown): boolean {
  const ev = (payload as { event?: { bot_id?: unknown; user?: unknown } } | undefined)?.event;
  if (!ev) return false;
  if (typeof ev.bot_id === 'string' && ev.bot_id.length > 0) return true;
  const user = ev.user;
  if (typeof user !== 'string') return false;
  for (const id of registry.identities) {
    if (id.slack?.bot_user_id === user) return true;
  }
  return false;
}

/**
 * Linear is the awkward one. The fleet shares ONE OAuth app and attributes each
 * agent via `createAsUser`, so there is no per-agent Linear id to match — and
 * `linear.user_id` is unset (`~`) on every identity today.
 *
 * Two signals instead, either sufficient:
 *
 *  - `botActor`, which Linear sets on anything an OAuth app created and leaves
 *    null for a person (see @linear/sdk, `Comment.botActor: ActorBot | null`).
 *    Any app counts here, not just ours: a sync integration's comment is still
 *    not the human intervention that should reset a loop counter.
 *  - our own reply footer, as a fallback in case a given webhook payload omits
 *    botActor. We generate that footer, so it is a reliable self-marker;
 *    `looksLikeOurFooter` is pinned to `renderFooter` by a test.
 *
 * MEASURED: the fallback is not the fallback — it is the whole mechanism. Neither
 * of the two live Linear triggers on IRS-46 carried a `botActor` key at all (not
 * null: absent), including session 278, which WAS an agent's own comment waking
 * the agent again. The footer is the only signal that has ever fired here. Keep
 * botActor for the payload shapes that do carry it, but do not rely on it.
 */
export function isLinearAgentAuthored(payload: unknown): boolean {
  const data = (payload as { data?: { botActor?: unknown; body?: unknown } } | undefined)?.data;
  if (!data) return false;
  if (data.botActor !== null && data.botActor !== undefined) return true;
  return typeof data.body === 'string' && looksLikeOurFooter(data.body);
}
