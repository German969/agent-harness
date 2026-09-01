// Placeholder resolution for hook configs.
//
// Two mechanisms:
//   1. `${VAR}` interpolation — replaced with values from a variables map
//   2. `<target-project>` / `<dev-team-state>` literal prefixes — replaced with
//      real filesystem paths from SessionContext
//
// Placeholders come from settings.json + mcp.json + scheduler entries.

import { join } from 'node:path';
import type { SessionContext } from './types.js';

/**
 * Build the placeholder variable map from a SessionContext.
 * Handlers use this to resolve `${PROJECT}` / `${SESSION_ID}` / `${TARGET_AGENT}` etc.
 */
export function contextVars(ctx: SessionContext): Record<string, string> {
  return {
    PROJECT: ctx.projectName,
    SESSION_ID: String(ctx.sessionId),
    AGENT: ctx.agent,
    // TARGET_AGENT is used by Harness's conditional_load — Phase 6c wires this
    // when the misbehavior-debugger skill triggers. For now, the current agent.
    TARGET_AGENT: ctx.agent,
    ...(ctx.skill ? { SKILL: ctx.skill } : {}),
  };
}

/**
 * Replace `${VAR}` with values from `vars`. Unknown variables are left literal
 * so downstream code can detect them and log a warning (rather than silently
 * expanding to empty strings, which would mask config bugs).
 */
export function resolveVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{([A-Z_]+)\}/g, (_match, name: string) => {
    const value = vars[name];
    return value !== undefined ? value : `\${${name}}`;
  });
}

/**
 * Resolve a path template that may contain `<target-project>` / `<dev-team-state>`
 * or `dev-team/` / `dev-team-state/` prefixes, plus `${VAR}` interpolations.
 *
 * Prefix map:
 *   `<target-project>/x/y`     → `<targetProjectRoot>/x/y`
 *   `<target-project>-marketing/…` → `<targetProjectRoot>-marketing/…`
 *   `dev-team/x/y`             → `<devTeamRoot>/x/y`
 *   `dev-team-state/…`         → sibling of devTeamRoot (per PLAN.md filesystem layout)
 *   anything else              → left as-is (absolute or relative)
 */
export function resolvePath(template: string, ctx: SessionContext): string {
  const interpolated = resolveVars(template, contextVars(ctx));

  if (interpolated.startsWith('<target-project>/')) {
    return join(ctx.targetProjectRoot, interpolated.slice('<target-project>/'.length));
  }
  if (interpolated.startsWith('<target-project>-marketing/')) {
    return `${ctx.targetProjectRoot}-marketing/${interpolated.slice('<target-project>-marketing/'.length)}`;
  }
  if (interpolated.startsWith('dev-team-state/')) {
    // dev-team-state is a sibling repo of dev-team (per PLAN.md filesystem layout).
    const sibling = join(ctx.devTeamRoot, '..', 'dev-team-state');
    return join(sibling, interpolated.slice('dev-team-state/'.length));
  }
  if (interpolated.startsWith('dev-team/')) {
    return join(ctx.devTeamRoot, interpolated.slice('dev-team/'.length));
  }
  return interpolated;
}
