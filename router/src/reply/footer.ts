// Session footer generator — appended to the final message when a session ends.
//
// Format (from ARCHITECTURE.md §2.5):
//   ---
//   *🤖 @<handle> • <skill> • <duration> • $<cost> • session `<id>`*
//
// `handle` comes from the identity's bot_username; falls back to `<agent>-agent`.
// The log-link (if `logLinkBase` is provided) wraps `<id>` as a markdown link.

import type { SessionFooter } from './types.js';

// The leading run of every footer renderFooter emits. Kept as a shared constant
// so the loop guard's self-detection cannot drift from what we actually render —
// a test asserts looksLikeOurFooter(renderFooter(...)).
const FOOTER_PREFIX = '\n\n---\n*🤖 @';

/**
 * Does this text end with a footer WE wrote? Used by the loop guard to recognise
 * an agent's own message coming back as a webhook on providers that don't name
 * the author usefully (Linear). Matches the rendered structure, not a loose emoji
 * search, so a human quoting the emoji is not mistaken for an agent.
 */
export function looksLikeOurFooter(text: string): boolean {
  return text.includes(FOOTER_PREFIX);
}

/**
 * A visible notice for a session that did NOT finish, rendered ABOVE the footer.
 *
 * The footer is small print; a truncated session needs to say so where a reader
 * will actually see it. Without this a `max_turns_reached` stop posts whatever
 * the agent happened to be narrating mid-sentence, and reads exactly like a
 * deliberate answer — observed on IRS-46, where a session cut off at turn 50
 * posted "Let's inspect the relevant type definitions..." as its final word.
 *
 * Returns '' for a completed session, so a normal reply is unchanged.
 */
export function renderOutcomeNotice(outcome: SessionFooter['outcome']): string {
  if (!outcome || outcome === 'completed') return '';
  const notice = OUTCOME_NOTICES[outcome];
  return `\n\n> **${notice.title}**\n> ${notice.detail}`;
}

const OUTCOME_NOTICES: Record<
  Exclude<NonNullable<SessionFooter['outcome']>, 'completed'>,
  { title: string; detail: string }
> = {
  // "Re-running starts from scratch" was true when this was written and is not
  // true now: a leased worktree outlives the session (nothing calls
  // removeWorktree in production), and acquireWorkspace hands the same one back
  // for the same task. Uncommitted edits survive and a re-run continues on top
  // of them. Saying otherwise invites someone to redo work that is already there.
  max_turns_reached: {
    title: '⚠️ Stopped at the turn limit — this is not a finished result.',
    detail:
      'Anything above is partial, and nothing was committed or pushed. Edits are kept ' +
      'in this task’s worktree, so a re-run continues from them rather than starting ' +
      'over; splitting the work into smaller tickets is usually the fix.',
  },
  cancelled: {
    title: '⚠️ Session cancelled before finishing.',
    detail:
      'Anything above is partial, and nothing was committed or pushed. Edits are kept ' +
      'in this task’s worktree for a re-run.',
  },
  error: {
    title: '⚠️ Session ended with an error — this is not a finished result.',
    detail: 'Anything above is partial. See the session log for the failure.',
  },
};

export function renderFooter(f: SessionFooter): string {
  // FOOTER_PREFIX already carries the `🤖 @`, so the handle leads the parts list.
  const parts: string[] = [];
  parts.push(f.handle ?? `${f.agent}-agent`);
  if (f.skill) parts.push(f.skill);
  parts.push(fmtDuration(f.durationMs));
  parts.push(`$${f.costUsd.toFixed(2)}`);
  parts.push(sessionLink(f));

  return `${FOOTER_PREFIX}${parts.join(' • ')}*`;
}

function sessionLink(f: SessionFooter): string {
  // Show the RESPONDING session's id — it matches the cost/duration/skill above,
  // which are all this session's. When the reply continues a thread opened by an
  // earlier session, append that thread root as a note so all replies in a thread
  // stay discoverable by one id, without mislabeling the session or its cost.
  // (Previously we displayed rootSessionId in place of sessionId, so a follow-up
  // rendered e.g. "session 154 • $0.89" where $0.89 was actually session 155's.)
  const id = f.sessionId;
  const idText = f.logLinkBase ? `[\`${id}\`](${f.logLinkBase}${id})` : `\`${id}\``;
  const thread =
    f.rootSessionId !== undefined && f.rootSessionId !== f.sessionId
      ? ` (thread \`${f.rootSessionId}\`)`
      : '';
  return `session ${idText}${thread}`;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs === 0 ? `${m}m` : `${m}m${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h${rm}m`;
}
