// Loop guard — the depth cap on agent→agent session chains.
//
// ARCHITECTURE.md §3.1: "Insert agent_chain row linking parent → child. Before
// invoking the child session, walk the chain backwards. If chain depth > 5
// without human intervention → refuse the child, post coordination_loop_suspected."
//
// Both halves existed as dead code (`recordLink`, `chainDepth`) and nothing ever
// called them, so the table stayed empty and the cap never bound. On 2026-08-28 a
// single Linear comment spawned sessions 211-273 — ~63 sessions, most on the
// `founding` skill — before a routing fix stopped it. That routing bug is fixed;
// this is the backstop that should have capped it regardless.
//
// "Without human intervention" is what keeps this from silencing a real
// conversation: only agent-authored triggers extend a chain, so a person replying
// starts a fresh one (see routing/authorship.ts).

import type { MatchReason } from '../routing/index.js';
import type { AgentChainVia } from '../state/index.js';
import type { Provider } from '../types.js';

/** ARCHITECTURE.md §9: default 5, "may need tuning based on realistic chains we observe." */
export const MAX_CHAIN_DEPTH = 5;

/**
 * Which surface carried the handoff, for the `agent_chain.via` column. This is
 * provenance for humans reading the table, not behaviour — depth counting treats
 * every hop alike.
 */
export function chainVia(
  provider: Provider,
  matchReason: MatchReason,
  crossThread = false,
): AgentChainVia {
  // A cross-thread hop is worth naming distinctly: reading the table, "this agent
  // made the ticket that woke that agent" is a different story from "they talked
  // in one thread", and it is the shape a decomposition fan-out produces.
  if (crossThread) return 'ticket_created';
  if (matchReason === 'linear_assignment') return 'linear_assign';
  if (matchReason === 'github_pr_owner') return 'pr_review';
  switch (provider) {
    case 'github':
      return 'github_comment';
    case 'slack':
      return 'slack_mention';
    default:
      return 'other';
  }
}
