// The three PreToolUse policy gates that had no handler: Marketer's login-gated
// fetch block, Guardian's dependency-manifest limit, and Marketer's customer-quote
// permission gate. Each config read as an enforced policy and enforced nothing.
//
// Every gate here is tested in both directions on purpose. A gate that never fires
// is the bug being fixed; a gate that over-fires gets switched off within a week,
// which is the same bug arriving more slowly.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blockIfUrlMatchesHandler } from '../../src/hooks/commands/block_if_url_matches.js';
import { testimonialPermissionCheckHandler } from '../../src/hooks/commands/testimonial_permission_check.js';
import {
  dependencyNames,
  versionBumpOnlyHandler,
} from '../../src/hooks/commands/version_bump_only.js';
import { getToolCallHandler, inferCommand } from '../../src/hooks/registry.js';
import { mkToolCtx } from './_rig.js';

// ---------------------------------------------------------------------------
// Marketer — login-gated fetch block
// ---------------------------------------------------------------------------
const URL_HOOK = {
  tool: ['WebFetch', 'WebSearch'],
  if_url_or_query_matches: ['login', '/account/', '/dashboard/', '/admin/', 'intranet'],
  deny_always: true,
  message: '🛑 public-information only',
};

describe('block_if_url_matches (marketer)', () => {
  it('is inferred and registered — inferCommand excluded this shape before', () => {
    expect(inferCommand(URL_HOOK)).toBe('block_if_url_matches');
    expect(getToolCallHandler('block_if_url_matches')).toBe(blockIfUrlMatchesHandler);
  });

  it('denies a login-gated URL', async () => {
    const r = await blockIfUrlMatchesHandler(
      URL_HOOK,
      mkToolCtx({ tool: 'WebFetch', input: { url: 'https://rival.com/account/billing' } }),
    );
    expect(r.kind).toBe('deny');
    if (r.kind === 'deny') expect(r.message).toBe('🛑 public-information only');
  });

  it('denies a search query aimed at the same content', async () => {
    const r = await blockIfUrlMatchesHandler(
      URL_HOOK,
      mkToolCtx({ tool: 'WebSearch', input: { query: 'rival intranet pricing' } }),
    );
    expect(r.kind).toBe('deny');
  });

  it('matches case-insensitively', async () => {
    const r = await blockIfUrlMatchesHandler(
      URL_HOOK,
      mkToolCtx({ tool: 'WebFetch', input: { url: 'https://rival.com/ADMIN/panel' } }),
    );
    expect(r.kind).toBe('deny');
  });

  it('allows ordinary public pages', async () => {
    for (const url of ['https://rival.com/pricing', 'https://rival.com/blog/2026-roadmap']) {
      const r = await blockIfUrlMatchesHandler(
        URL_HOOK,
        mkToolCtx({ tool: 'WebFetch', input: { url } }),
      );
      expect(r.kind).toBe('allow');
    }
  });

  it('leaves other tools alone', async () => {
    const r = await blockIfUrlMatchesHandler(
      URL_HOOK,
      mkToolCtx({ tool: 'Read', input: { url: 'https://rival.com/login' } }),
    );
    expect(r.kind).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// Guardian — dependency manifests
// ---------------------------------------------------------------------------
const DEP_HOOK = {
  tool: 'Edit',
  if_path_matches: ['**/package.json', '**/Cargo.toml', '**/pyproject.toml', '**/go.mod'],
  validate: 'version_bump_only',
  on_violation_message: '🛑 bumps only',
};

function edit(file_path: string, old_string: string, new_string: string) {
  return versionBumpOnlyHandler(
    DEP_HOOK,
    mkToolCtx({ tool: 'Edit', input: { file_path, old_string, new_string } }),
  );
}

describe('version_bump_only (guardian)', () => {
  it('is inferred from its validate name and registered', () => {
    expect(inferCommand(DEP_HOOK)).toBe('version_bump_only');
    expect(getToolCallHandler('version_bump_only')).toBe(versionBumpOnlyHandler);
  });

  it('allows a CVE bump — the thing Guardian is for', async () => {
    const r = await edit('/repo/package.json', '"lodash": "^4.17.20"', '"lodash": "^4.17.21"');
    expect(r.kind).toBe('allow');
  });

  it('denies adding a dependency', async () => {
    const r = await edit(
      '/repo/package.json',
      '"lodash": "^4.17.21"',
      '"lodash": "^4.17.21",\n"left-pad": "^1.3.0"',
    );
    expect(r.kind).toBe('deny');
    if (r.kind === 'deny') expect(r.message).toBe('🛑 bumps only');
  });

  it('denies removing a dependency', async () => {
    const r = await edit(
      '/repo/package.json',
      '"lodash": "^4.17.21",\n"left-pad": "^1.3.0"',
      '"lodash": "^4.17.21"',
    );
    expect(r.kind).toBe('deny');
  });

  it('handles the TOML and go.mod forms, not just package.json', async () => {
    expect((await edit('/repo/Cargo.toml', 'serde = "1.0.1"', 'serde = "1.0.2"')).kind).toBe(
      'allow',
    );
    expect(
      (await edit('/repo/Cargo.toml', 'serde = "1.0.1"', 'serde = "1.0.1"\ntokio = "1.35.0"')).kind,
    ).toBe('deny');
    expect(
      (
        await edit(
          '/repo/go.mod',
          'github.com/pkg/errors v0.9.1',
          'github.com/pkg/errors v0.9.1\ngithub.com/spf13/cobra v1.8.0',
        )
      ).kind,
    ).toBe('deny');
  });

  it('ignores files outside the manifest globs', async () => {
    const r = await edit('/repo/src/index.ts', 'const a = 1;', 'const b = 2;');
    expect(r.kind).toBe('allow');
  });

  it('allows a manifest edit that touches no dependency lines', async () => {
    // package.json also holds scripts and metadata; this gate is about dep churn.
    const r = await edit('/repo/package.json', '"version": "1.0.0"', '"version": "1.0.1"');
    expect(r.kind).toBe('allow');
  });

  it('allows when there is no before/after to compare', async () => {
    const r = await versionBumpOnlyHandler(
      DEP_HOOK,
      mkToolCtx({ tool: 'Edit', input: { file_path: '/repo/package.json' } }),
    );
    expect(r.kind).toBe('allow');
  });
});

describe('dependencyNames', () => {
  it('reads the four manifest forms and skips comments', () => {
    expect([...dependencyNames('"lodash": "^4.17.21"')]).toEqual(['lodash']);
    expect([...dependencyNames('serde = { version = "1" }')]).toEqual(['serde']);
    expect([...dependencyNames('github.com/pkg/errors v0.9.1')]).toEqual(['github.com/pkg/errors']);
    expect([...dependencyNames('# "lodash": "^4.17.21"')]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Marketer — customer-quote permission gate
// ---------------------------------------------------------------------------
let stateRoot: string;
let devTeamRoot: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'testimonial-'));
  devTeamRoot = join(stateRoot, 'dev-team');
  mkdirSync(devTeamRoot, { recursive: true });
  const dir = join(stateRoot, 'dev-team-state', 'projects', 'testproj', 'marketer', 'testimonials');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'approved.md'),
    [
      '# Acme Corp',
      'quote: "Iris cut our support backlog in half within a month."',
      'approved: yes',
      '',
      '# Globex',
      'quote: "We replaced four tools with Iris and never looked back."',
      'approved: no',
      '',
    ].join('\n'),
    'utf-8',
  );
});
afterEach(() => rmSync(stateRoot, { recursive: true, force: true }));

const QUOTE_HOOK = {
  tool: ['Write', 'Edit', 'mcp__cms__create_draft'],
  if_content_matches_pattern: 'quote|testimonial|customer said|in <customer>',
  validate: 'testimonial_permission_check',
  validator_path: 'dev-team-state/projects/${PROJECT}/marketer/testimonials/approved.md',
  on_violation_message: '🛑 unapproved quote',
};

function draft(content: string, tool = 'Write') {
  return testimonialPermissionCheckHandler(
    QUOTE_HOOK,
    mkToolCtx({ tool, input: { content }, agent: 'marketer', devTeamRoot }),
  );
}

describe('testimonial_permission_check (marketer)', () => {
  it('is inferred from its validate name and registered', () => {
    expect(inferCommand(QUOTE_HOOK)).toBe('testimonial_permission_check');
    expect(getToolCallHandler('testimonial_permission_check')).toBe(
      testimonialPermissionCheckHandler,
    );
  });

  it('allows a quote approved: yes', async () => {
    const r = await draft(
      'Our customers agree. As one customer said, "Iris cut our support backlog in half within a month."',
    );
    expect(r.kind).toBe('allow');
  });

  it('allows an approved quote that was re-wrapped', async () => {
    // Copy gets reflowed; the library entry should still clear it.
    const r = await draft(
      'A testimonial: "Iris cut our support backlog\n   in half within a month."',
    );
    expect(r.kind).toBe('allow');
  });

  it('denies a quote whose library entry is approved: no', async () => {
    // The case the gate exists for — a real row that has not been cleared.
    const r = await draft(
      'A testimonial: "We replaced four tools with Iris and never looked back."',
    );
    expect(r.kind).toBe('deny');
    if (r.kind === 'deny') expect(r.message).toBe('🛑 unapproved quote');
  });

  it('denies a quote that is not in the library at all', async () => {
    const r = await draft('One customer said, "This product completely changed how we operate."');
    expect(r.kind).toBe('deny');
  });

  it('ignores short quoted spans — product names and UI labels', async () => {
    // A gate that fires on "Export" gets turned off, which is the same bug slower.
    const r = await draft('Click "Export" to download the testimonial report.');
    expect(r.kind).toBe('allow');
  });

  it('allows content that mentions testimonials but quotes nobody', async () => {
    const r = await draft('This quarter we should collect more customer testimonials.');
    expect(r.kind).toBe('allow');
  });

  it('does not run on content that fails the pre-filter', async () => {
    const r = await draft(
      'A long product announcement with "no relevant trigger words here at all."',
    );
    expect(r.kind).toBe('allow');
  });

  it('denies when the library is missing — first quote must not slip through', async () => {
    const r = await testimonialPermissionCheckHandler(
      { ...QUOTE_HOOK, validator_path: 'dev-team-state/nope/approved.md' },
      mkToolCtx({
        tool: 'Write',
        input: { content: 'A testimonial: "Iris cut our support backlog in half within a month."' },
        agent: 'marketer',
        devTeamRoot,
      }),
    );
    expect(r.kind).toBe('deny');
  });

  it('covers the draft MCP tools, not just Write', async () => {
    const r = await draft(
      'A testimonial: "This product completely changed how we operate here."',
      'mcp__cms__create_draft',
    );
    expect(r.kind).toBe('deny');
  });

  it('leaves tools outside its list alone', async () => {
    const r = await draft(
      'A testimonial: "This product completely changed how we operate."',
      'Bash',
    );
    expect(r.kind).toBe('allow');
  });
});
