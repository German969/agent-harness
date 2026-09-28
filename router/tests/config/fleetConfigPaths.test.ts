// HAR-25: fleet-config.yml must fire on every file `validate:fleet` reads.
//
// Its `paths` listed a handful of router files by name while the validator grew to
// import dozens. routing/skill.ts, which checks 5, 9 and 10 read, was not among
// them, so a PR touching only skill.ts never ran the validator. This test walks the
// validator's import graph and fails on any file the workflow's paths miss, so the
// next import cannot reopen the gap silently.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { minimatch } from 'minimatch';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const VALIDATOR = 'router/scripts/validate-fleet-config.ts';
const WORKFLOW = '.github/workflows/fleet-config.yml';
const CI = '.github/workflows/ci.yml';

/**
 * Paths, relative to `root`, of every local module `entry` imports, transitively,
 * itself included. TypeScript's own pre-parser finds every import form: `from`,
 * side-effect (`import './x.js'`), re-export, type-only and dynamic `import()`.
 */
function importClosure(root: string, entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const { importedFiles } = ts.preProcessFile(
      readFileSync(join(root, file), 'utf-8'),
      true,
      true,
    );
    for (const { fileName } of importedFiles) {
      if (!fileName.startsWith('.')) continue; // a package or node: builtin
      const target = normalize(join(dirname(file), fileName)).replace(/\.js$/, '');
      const hit = [`${target}.ts`, join(target, 'index.ts')].find((c) => existsSync(join(root, c)));
      if (!hit) throw new Error(`${file}: cannot resolve import '${fileName}'`);
      stack.push(hit);
    }
  }
  return [...seen].sort();
}

function workflowPaths(workflow: string): { pr: string[]; push: string[] } {
  const doc = load(readFileSync(join(repoRoot, workflow), 'utf-8')) as {
    on: { pull_request: { paths: string[] }; push: { paths: string[] } };
  };
  return { pr: doc.on.pull_request.paths, push: doc.on.push.paths };
}

const covered = (paths: string[], file: string) => paths.some((p) => minimatch(file, p));

describe('importClosure', () => {
  it('follows every local import form, and skips packages', () => {
    const root = mkdtempSync(join(tmpdir(), 'closure-'));
    mkdirSync(join(root, 'lib'));
    const files: Record<string, string> = {
      'entry.ts': [
        "import './side.js';",
        "import type { T } from './typed.js';",
        "export * from './lib/index.js';",
        "import { readFileSync } from 'node:fs';",
        "const later = await import('./dynamic.js');",
      ].join('\n'),
      'side.ts': '',
      'typed.ts': 'export type T = 1;',
      'lib/index.ts': "export { x } from '../deep.js';",
      'deep.ts': 'export const x = 1;',
      'dynamic.ts': '',
    };
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
    expect(importClosure(root, 'entry.ts')).toEqual(
      ['deep.ts', 'dynamic.ts', 'entry.ts', 'lib/index.ts', 'side.ts', 'typed.ts'].sort(),
    );
  });

  it('fails loudly on a local import it cannot resolve', () => {
    const root = mkdtempSync(join(tmpdir(), 'closure-'));
    writeFileSync(join(root, 'entry.ts'), "import './missing.js';");
    expect(() => importClosure(root, 'entry.ts')).toThrow(
      /cannot resolve import '\.\/missing\.js'/,
    );
  });
});

describe('fleet-config.yml paths', () => {
  const { pr, push } = workflowPaths(WORKFLOW);

  it('are the same for pull_request and push', () => {
    expect(pr).toEqual(push);
  });

  it("cover every file in the validator's import graph", () => {
    const closure = importClosure(repoRoot, VALIDATOR);
    // The graph is dozens of files; a floor keeps a broken walk from passing vacuously.
    expect(closure.length).toBeGreaterThan(30);
    expect(closure).toContain('router/src/routing/skill.ts');
    expect(closure.filter((f) => !covered(pr, f))).toEqual([]);
  });

  // This guard is a vitest test, so it runs in ci.yml. A PR changing only
  // fleet-config.yml must run it too, or that PR could drop these paths unchecked.
  it('are guarded on every change to the workflow itself', () => {
    const ci = workflowPaths(CI);
    expect(covered(ci.pr, WORKFLOW)).toBe(true);
    expect(covered(ci.push, WORKFLOW)).toBe(true);
  });

  it('cover the non-code inputs it reads, and its dependencies', () => {
    for (const file of [
      'agents/PROTOCOLS.md',
      'agents/linear-labels.yml',
      'agents/github-pr-labels.yml',
      'agents/guardian/sensitive-paths.yml',
      'agents/strategist/settings.json',
      'agents/strategist/skills/pm.md',
      'identities/strategist.yml',
      'router/package.json',
      'router/pnpm-lock.yaml',
    ]) {
      expect(existsSync(join(repoRoot, file)), file).toBe(true);
      expect(covered(pr, file), file).toBe(true);
    }
  });
});
