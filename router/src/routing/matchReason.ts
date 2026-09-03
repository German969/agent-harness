// What a classifier match reason IS, and what it means.
//
// Its own module because two consumers need it and they sit on opposite sides of
// a call: `classifier.ts` produces the reason, `skill.ts` reads it to resolve a
// skill, and the classifier calls `resolveSkill`. Declaring the type in the
// classifier would make skill.ts import back into it and close a cycle.

/** Why the classifier picked this agent for this event. */
export type MatchReason =
  | 'explicit_mention'
  | 'linear_assignment'
  | 'github_auto_trigger'
  | 'github_pr_owner'
  | 'github_pr_closed'
  | 'linear_label'
  | 'slack_channel_default'
  | 'agent_hint';

/**
 * Match reasons that mean real WORK was routed to the agent (a ticket assigned or
 * labelled, a PR opened, an event on a PR the agent owns) rather than a question.
 * Work sessions get a real work skill and a writable worktree; conversations get
 * neither.
 *
 * `github_pr_closed` is deliberately absent: a merged or closed PR still deserves
 * a reply, but there is nothing left to build, so it takes the cheap
 * conversational skill and no checkout.
 */
const WORK_TRIGGER_REASONS: ReadonlySet<MatchReason> = new Set<MatchReason>([
  'linear_assignment',
  'github_auto_trigger',
  'github_pr_owner',
  'linear_label',
]);

export function isWorkTrigger(reason: MatchReason): boolean {
  return WORK_TRIGGER_REASONS.has(reason);
}
