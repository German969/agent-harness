// SessionStart hook — command: 'conditional_load'
// Skill-conditional load: only loads paths if the active skill matches an entry
// in the `by_skill` map. Same load semantics as `load` for each matched skill's paths.

import { readFileSync } from 'node:fs';
import { resolvePath } from '../placeholder.js';
import type { HookHandler, HookResult } from '../types.js';
import { renderLoadedFile } from './load.js';

type ConditionalLoadConfig = {
  by_skill?: Record<string, unknown>;
};

export const conditionalLoadHandler: HookHandler = async (config, ctx): Promise<HookResult> => {
  const cfg = config as ConditionalLoadConfig;
  const bySkill = cfg.by_skill ?? {};
  const activeSkill = ctx.skill;

  if (!activeSkill) {
    return { kind: 'side-effect', summary: 'conditional_load: no active skill; skipped' };
  }

  const paths = bySkill[activeSkill];
  if (!Array.isArray(paths) || paths.length === 0) {
    return {
      kind: 'side-effect',
      summary: `conditional_load: no paths for skill ${activeSkill}`,
    };
  }

  const parts: string[] = [];
  for (const template of paths as string[]) {
    const resolved = resolvePath(template, ctx);
    try {
      const content = readFileSync(resolved, 'utf-8');
      parts.push(renderLoadedFile(template, resolved, content, ctx));
    } catch (err) {
      // Conditional loads are optional by nature — log + continue.
      ctx.log.warn(
        { template, resolved, reason: (err as Error).message, skill: activeSkill },
        'conditional_load: file missing (skipped)',
      );
    }
  }

  return {
    kind: 'context',
    content: parts.join('\n\n---\n\n'),
    tag: `sessionstart:conditional_load:${activeSkill}`,
  };
};
