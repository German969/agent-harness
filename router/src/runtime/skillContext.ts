// The active skill's procedure, delivered to the session that resolved it.
//
// `agentLoader` has loaded `agents/<agent>/skills/*.md` into `AgentConfig.skills`
// since it was written, and NOTHING has ever read that map. The classifier
// resolves a SkillId, and the router uses it to pick a model, gate MCP servers,
// filter `only_skills` load hooks and label the session row — but never told the
// session which skill it was in, let alone what that skill says to do.
//
// Every agent's CLAUDE.md is written on the opposite assumption. Builder-Server's
// skill table ends with "Skills load conditionally based on trigger context", and
// the procedures themselves live only in the skill files. So the parts of an
// agent's job that CLAUDE.md spells out got done, and the parts documented only in
// a skill file never did: Builder-Server writes `active-prs.md` (a phase of the
// dev cycle, in CLAUDE.md) on every PR, and has never once written
// `coding-practices.md` — whose lesson-capture procedure exists only in
// `pr-feedback.md`, a file no session has ever seen.
//
// The block joins `initialContext`, which the adapter composes into the system
// prompt, so it sits in the cached prefix and is written once per thread rather
// than re-sent per turn.

import type { Logger } from 'pino';
import type { AgentConfig } from '../config/index.js';
import type { AgentId, SkillId } from '../types.js';

export type ContextBlock = { content: string; tag?: string };

/**
 * The context block for `skill`, or undefined when there is nothing to deliver.
 *
 * Never throws and never refuses a session. A missing skill file is exactly the
 * behaviour every session had until now — the agent still has its CLAUDE.md — and
 * degrading to that beats failing to answer. `validate:fleet` gates it at CI so
 * the gap cannot stay silent.
 */
export function skillContextBlock(
  config: AgentConfig,
  skill: SkillId | undefined,
  meta: { agent: AgentId; sessionId: number; log: Logger },
): ContextBlock | undefined {
  if (!skill) return undefined;

  const body = config.skills.get(skill);
  if (!body) {
    meta.log.warn(
      { agent: meta.agent, skill, sessionId: meta.sessionId },
      'active skill has no agents/<agent>/skills/<skill>.md — session runs without its procedure',
    );
    return undefined;
  }

  // Named, not just concatenated. The agent's CLAUDE.md refers to its skills by
  // name throughout ("see the `pr-feedback` skill for the procedure"), so the
  // session has to be able to tell which one it is in — the body alone reads as
  // one more reference document.
  const header = `# Active skill: ${skill}\n\n<!-- Resolved by the router from this session's trigger. This is the procedure to follow; your CLAUDE.md is the standing context around it. -->`;
  return { tag: 'active-skill', content: `${header}\n\n${body}` };
}
