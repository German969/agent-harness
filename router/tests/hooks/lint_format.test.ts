// The post-edit formatter — previously a stub that logged and returned, so five
// agents' formatting hooks had never run. Exercised against a REAL biome project
// on disk, because the two things that can silently no-op are detection (finding
// the tool) and execution (actually invoking it), and neither is visible from a
// mocked result.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatAndLintHandler, lintAndFormatHandler } from '../../src/hooks/commands/lint_stubs.js';
import { STUB_HANDLERS, getToolCallHandler } from '../../src/hooks/registry.js';
import { mkToolCtx } from './_rig.js';

let project: string;

// The router's own biome binary, linked into the fixture so the handler finds a
// local install exactly as it would in a real checkout.
const localBiome = join(process.cwd(), 'node_modules', '.bin', 'biome');

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'fmt-'));
  writeFileSync(
    join(project, 'biome.json'),
    JSON.stringify({ formatter: { enabled: true, indentStyle: 'space', indentWidth: 2 } }),
    'utf-8',
  );
  mkdirSync(join(project, 'node_modules', '.bin'), { recursive: true });
  if (existsSync(localBiome)) {
    writeFileSync(
      join(project, 'node_modules', '.bin', 'biome'),
      `#!/bin/sh\nexec "${localBiome}" "$@"\n`,
      { encoding: 'utf-8', mode: 0o755 },
    );
  }
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

function run(file: string, config: Record<string, unknown> = {}) {
  return lintAndFormatHandler(
    { tool: ['Edit', 'Write'], fix: true, ...config },
    mkToolCtx({
      tool: 'Edit',
      input: { file_path: file },
      agent: 'harness',
      targetProjectRoot: project,
    }),
  );
}

describe('lint_and_format', () => {
  it('is no longer registered as a stub', () => {
    // The gate in validate-fleet-config.ts reads this set; an entry here means the
    // hook is knowingly doing nothing.
    expect(STUB_HANDLERS.has('lint_and_format')).toBe(false);
    expect(STUB_HANDLERS.has('format_and_lint')).toBe(false);
    expect(getToolCallHandler('lint_and_format')).toBe(lintAndFormatHandler);
    expect(getToolCallHandler('format_and_lint')).toBe(formatAndLintHandler);
  });

  it('actually rewrites a badly formatted file', async () => {
    const file = join(project, 'ugly.ts');
    writeFileSync(file, 'export const x = {a:1,b:2}\n', 'utf-8');

    const r = await run(file);

    expect(r.kind).toBe('side-effect');
    const after = readFileSync(file, 'utf-8');
    // The assertion that matters: the file on disk changed. A stub would leave it.
    expect(after).not.toBe('export const x = {a:1,b:2}\n');
    expect(after).toContain('a: 1');
  });

  it('reports which formatter ran, so a no-op is visible in the log', async () => {
    const file = join(project, 'ok.ts');
    writeFileSync(file, 'export const y = 1;\n', 'utf-8');
    const r = await run(file);
    if (r.kind === 'side-effect') {
      expect(r.summary).toContain('biome');
      expect(r.data?.formatter).toBe('biome');
    }
  });

  it('skips a project with no formatter config rather than guessing', async () => {
    rmSync(join(project, 'biome.json'));
    const file = join(project, 'x.ts');
    writeFileSync(file, 'export const x = {a:1}\n', 'utf-8');

    const r = await run(file);
    expect(r.kind).toBe('side-effect');
    if (r.kind === 'side-effect') expect(r.summary).toContain('no formatter detected');
    expect(readFileSync(file, 'utf-8')).toBe('export const x = {a:1}\n');
  });

  it('skips an extension the detected formatter does not handle', async () => {
    const file = join(project, 'notes.md');
    writeFileSync(file, '#  heading\n', 'utf-8');
    const r = await run(file);
    if (r.kind === 'side-effect') expect(r.summary).toContain('no formatter detected');
  });

  it('honours if_path_matches, including repo-relative globs against an absolute path', async () => {
    const dir = join(project, 'router', 'src');
    mkdirSync(dir, { recursive: true });
    const inScope = join(dir, 'a.ts');
    const outOfScope = join(project, 'b.ts');
    writeFileSync(inScope, 'export const a = {x:1}\n', 'utf-8');
    writeFileSync(outOfScope, 'export const b = {x:1}\n', 'utf-8');
    const cfg = { if_path_matches: ['router/src/**/*.ts'] };

    expect((await run(outOfScope, cfg)).kind).toBe('side-effect');
    expect(readFileSync(outOfScope, 'utf-8')).toBe('export const b = {x:1}\n');

    await run(inScope, cfg);
    expect(readFileSync(inScope, 'utf-8')).toContain('x: 1');
  });

  it('never fails the session on a file it cannot handle', async () => {
    const missing = join(project, 'gone.ts');
    const r = await run(missing);
    expect(r.kind).toBe('side-effect');
    if (r.kind === 'side-effect') expect(r.summary).toContain('not on disk');

    const broken = join(project, 'broken.ts');
    writeFileSync(broken, 'export const = = = ;;;\n', 'utf-8');
    const r2 = await run(broken);
    // A parse error is information, not a failed turn.
    expect(r2.kind).toBe('side-effect');
  });

  it('ignores tools it is not configured for', async () => {
    const file = join(project, 'z.ts');
    writeFileSync(file, 'export const z = {a:1}\n', 'utf-8');
    const r = await lintAndFormatHandler(
      { tool: ['Edit'], fix: true },
      mkToolCtx({
        tool: 'Bash',
        input: { file_path: file },
        agent: 'harness',
        targetProjectRoot: project,
      }),
    );
    expect(r.kind).toBe('side-effect');
    expect(readFileSync(file, 'utf-8')).toBe('export const z = {a:1}\n');
  });
});

describe('formatter fixture sanity', () => {
  it('the fixture biome actually works, so a pass above is not a false negative', () => {
    if (!existsSync(localBiome)) return;
    const file = join(project, 'sanity.ts');
    writeFileSync(file, 'export const s = {a:1}\n', 'utf-8');
    execFileSync(localBiome, ['check', '--write', file], { cwd: project, stdio: 'ignore' });
    expect(readFileSync(file, 'utf-8')).toContain('a: 1');
  });
});
