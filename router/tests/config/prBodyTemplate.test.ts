// The router's own automatic PRs must pass the provenance gate.
//
// Harness's and Guardian's SessionEnd `create_pr` hooks carry a `pr_body_template`
// ending in `Agent: <persona>`, and that template is now the ONLY thing making their
// PRs attributable. Copilot raised on #62 that nothing exercised it: the existing
// create_pr tests build ad-hoc configs, so a JSON-escaping or template-wiring
// regression would fail every automatic PR of that agent with nothing catching it.
//
// Not theoretical — the escaping WAS wrong twice while writing it, landing a literal
// `\n` that would have put the trailer mid-line. So this reads the REAL settings files
// and feeds the real template through the real resolver, rather than asserting on a
// fixture that could drift from either.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveProvenance } from '../../src/config/prProvenance.js';

const repoRoot = join(process.cwd(), '..');
const agentsDir = join(repoRoot, 'agents');

const personas = new Set(
  readdirSync(agentsDir).filter(
    (n) => !n.startsWith('.') && statSync(join(agentsDir, n)).isDirectory(),
  ),
);

type Hook = Record<string, unknown>;

function createPrHooks(agent: string): Hook[] {
  const settings = JSON.parse(readFileSync(join(agentsDir, agent, 'settings.json'), 'utf-8')) as {
    hooks?: { SessionEnd?: Hook[] };
  };
  return (settings.hooks?.SessionEnd ?? []).filter((h) => h.create_pr === true);
}

const agentsWithCreatePr = [...personas].filter((a) => createPrHooks(a).length > 0).sort();

describe('every create_pr hook sends a body the provenance gate accepts', () => {
  it('finds the hooks at all, so this suite cannot pass by testing nothing', () => {
    // Guards the loop below: if a refactor renames `create_pr`, the it.each would
    // silently iterate an empty list and report green.
    expect(agentsWithCreatePr.length).toBeGreaterThan(0);
  });

  it.each(agentsWithCreatePr)('%s', (agent) => {
    for (const hook of createPrHooks(agent)) {
      const body = hook.pr_body_template;
      expect(typeof body, `${agent}: create_pr hook has no pr_body_template`).toBe('string');

      // The whole failure mode: a literal backslash-n instead of a newline puts the
      // trailer mid-line, where the parser correctly refuses it.
      expect(body as string).toMatch(/^Agent: [a-z-]+$/m);

      const result = resolveProvenance([{ source: 'the PR body', text: body as string }], personas);
      expect(result.kind, `${agent}: its own PR body would fail the gate`).toBe('ok');
      expect(result.kind === 'ok' && result.persona).toBe(agent);
    }
  });
});
