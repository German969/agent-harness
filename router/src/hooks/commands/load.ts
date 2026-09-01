// SessionStart hook — command: 'load'
// Reads a list of files; returns their concatenated contents as SessionContext content.
// Missing files are handled per `missing` policy (warn/error/ignore) with per-path exceptions.

import { readFileSync } from 'node:fs';
import { contextVars, resolvePath, resolveVars } from '../placeholder.js';
import type { HookHandler, HookResult, SessionContext } from '../types.js';

/**
 * Render a loaded file as a context block. The header shows the logical label with
 * ${VAR} expanded (e.g. ${PROJECT} → iris) PLUS the real on-disk path. Agents write
 * their own state back by editing these files; a bare `dev-team-state/...` path
 * resolves against the read-only dev-team cwd and misses, so surfacing the absolute
 * path is what makes read/write reliable. Shared by `load` and `conditional_load`.
 */
export function renderLoadedFile(
  template: string,
  resolved: string,
  content: string,
  ctx: SessionContext,
): string {
  const label = resolveVars(template, contextVars(ctx));
  const header =
    label === resolved
      ? `# ${label}`
      : `# ${label}\n<!-- read & write this file at its on-disk path: ${resolved} -->`;
  return `${header}\n\n${content}`;
}

type MissingPolicy =
  | 'warn'
  | 'error'
  | 'ignore'
  | 'ignore_pre_phase_3'
  | 'ignore_early_project'
  | 'ignore_first_session'
  | 'ignore_if_absent';

type LoadConfig = {
  paths: unknown;
  missing?: MissingPolicy;
  missingException?: Record<string, MissingPolicy>;
  /** When present, load these paths only if the session's skill is in the list.
   *  Lets an agent keep a small always-on context (e.g. house-style docs) while
   *  gating heavier context (architecture, ADR index, state) to the skills that
   *  actually need it — so light/Q&A sessions don't pay to cache-write it. */
  only_skills?: unknown;
};

export const loadHandler: HookHandler = async (config, ctx): Promise<HookResult> => {
  const cfg = config as LoadConfig;

  const onlySkills = Array.isArray(cfg.only_skills) ? (cfg.only_skills as string[]) : undefined;
  if (onlySkills && (!ctx.skill || !onlySkills.includes(ctx.skill))) {
    return {
      kind: 'side-effect',
      summary: `load: skipped (skill ${ctx.skill ?? 'none'} not in only_skills)`,
    };
  }

  const paths = Array.isArray(cfg.paths) ? (cfg.paths as string[]) : [];
  if (paths.length === 0) {
    return { kind: 'error', error: new Error('load: no paths configured') };
  }

  const defaultMissing: MissingPolicy = cfg.missing ?? 'warn';
  const exceptions = cfg.missingException ?? {};

  const parts: string[] = [];
  for (const template of paths) {
    const resolved = resolvePath(template, ctx);
    const missing: MissingPolicy = exceptions[template] ?? defaultMissing;

    let content: string | undefined;
    try {
      content = readFileSync(resolved, 'utf-8');
    } catch (err) {
      const errMsg = (err as Error).message;
      if (missing === 'error') {
        return {
          kind: 'error',
          error: new Error(`load: required file missing: ${template} → ${resolved} (${errMsg})`),
        };
      }
      if (missing === 'warn') {
        ctx.log.warn({ template, resolved, reason: errMsg }, 'load: file missing (warn)');
      }
      // All `ignore*` variants (and 'warn' after logging) fall through as skipped.
      continue;
    }

    parts.push(renderLoadedFile(template, resolved, content, ctx));
  }

  return {
    kind: 'context',
    content: parts.join('\n\n---\n\n'),
    tag: 'sessionstart:load',
  };
};
