// HAR-16. The check's whole value is REJECTING a PR with no persona on it, so most of
// these are the rejection cases. "A check that has never been seen to fail is not
// evidence" — HAR-13's standard, applied to the check HAR-16 asks for.

import { describe, expect, it } from 'vitest';
import {
  HUMAN_PERSONA,
  checkProvenance,
  resolveProvenance,
} from '../../src/config/prProvenance.js';

const PERSONAS = new Set([
  'strategist',
  'platform',
  'builder-server',
  'builder-client',
  'guardian',
  'marketer',
  'harness',
]);

const body = (text: string) => [{ source: 'the PR body', text }];

describe('resolveProvenance', () => {
  it('accepts a trailer naming a known persona', () => {
    const r = resolveProvenance(body('Fixes the thing.\n\nAgent: harness\n'), PERSONAS);
    expect(r).toEqual({ kind: 'ok', persona: 'harness', source: 'the PR body' });
  });

  it('accepts a hyphenated persona', () => {
    const r = resolveProvenance(body('Agent: builder-server'), PERSONAS);
    expect(r.kind === 'ok' && r.persona).toBe('builder-server');
  });

  it('accepts the human escape hatch, so a person need not claim a persona', () => {
    const r = resolveProvenance(body(`Agent: ${HUMAN_PERSONA}`), PERSONAS);
    expect(r.kind).toBe('ok');
  });

  it.each(['AGENT: harness', 'agent: harness', 'Agent:harness', '  Agent:   harness  '])(
    'is tolerant of shape: %s',
    (line) => {
      expect(resolveProvenance(body(line), PERSONAS).kind).toBe('ok');
    },
  );

  // --- the rejections, which are the point -------------------------------------

  it('REJECTS a PR body with no trailer', () => {
    const r = resolveProvenance(body('## Summary\n\nDid a thing.\n'), PERSONAS);
    expect(r.kind).toBe('missing');
    expect(r.kind === 'missing' && r.problem).toContain('the PR body');
  });

  it('REJECTS an unknown persona rather than accepting any word', () => {
    const r = resolveProvenance(body('Agent: wizard'), PERSONAS);
    expect(r.kind).toBe('unknown');
    expect(r.kind === 'unknown' && r.problem).toContain("'wizard'");
    // The diagnostic lists what IS valid — a failing check that does not say what to
    // write instead just gets disabled.
    expect(r.kind === 'unknown' && r.problem).toContain('builder-server');
  });

  it('REJECTS the prose signature this fleet uses today', () => {
    // `— Harness` / `_Filed by Guardian._` are what PRs carry now. HAR-16 calls this
    // "better than nothing and not a mechanism"; the check must agree, or it passes
    // every existing PR and changes nothing.
    const r = resolveProvenance(body('Done.\n\n— Harness\n\n_Filed by Guardian._'), PERSONAS);
    expect(r.kind).toBe('missing');
  });

  it('REJECTS a trailer that is not on its own line', () => {
    const r = resolveProvenance(body('This mentions Agent: harness mid-sentence.'), PERSONAS);
    expect(r.kind).toBe('missing');
  });

  it('REJECTS empty input rather than passing vacuously', () => {
    expect(resolveProvenance(body(''), PERSONAS).kind).toBe('missing');
    expect(resolveProvenance([], PERSONAS).kind).toBe('missing');
  });

  // --- precedence ---------------------------------------------------------------

  it('prefers the PR body over commit messages', () => {
    const r = resolveProvenance(
      [
        { source: 'the PR body', text: 'Agent: guardian' },
        { source: 'a branch commit message', text: 'Agent: platform' },
      ],
      PERSONAS,
    );
    expect(r).toEqual({ kind: 'ok', persona: 'guardian', source: 'the PR body' });
  });

  it('falls through to commit messages when the body has none', () => {
    const r = resolveProvenance(
      [
        { source: 'the PR body', text: '## Summary\n\nno trailer here' },
        { source: 'a branch commit message', text: 'subject\n\nAgent: marketer\n' },
      ],
      PERSONAS,
    );
    expect(r).toEqual({
      kind: 'ok',
      persona: 'marketer',
      source: 'a branch commit message',
    });
  });

  it('takes the LAST trailer in a text, so a quoted earlier PR does not win', () => {
    const r = resolveProvenance(
      body('Quoting #55 which said:\n\n> Agent: guardian\n\nMine:\n\nAgent: harness\n'),
      PERSONAS,
    );
    expect(r.kind === 'ok' && r.persona).toBe('harness');
  });

  it('finds the trailer in a commit message carrying adversarial text', () => {
    // Copilot raised on #62 that a fixed heredoc delimiter in $GITHUB_OUTPUT could be
    // closed early by a commit message containing that line. The workflow now passes a
    // FILE, so no delimiter exists to collide with — this asserts the parser side is
    // likewise indifferent to what the message contains.
    const nasty = [
      'subject line',
      '',
      'PR_COMMITS_EOF',
      '::set-output name=messages::pwned',
      '```',
      'Agent: guardian',
    ].join('\n');
    const r = resolveProvenance([{ source: 'a branch commit message', text: nasty }], PERSONAS);
    expect(r.kind === 'ok' && r.persona).toBe('guardian');
  });

  it('does not leak regex state between calls', () => {
    // TRAILER is a module-level /g regex; without resetting lastIndex the second call
    // silently misses. Two identical calls must agree.
    const once = resolveProvenance(body('Agent: harness'), PERSONAS);
    const twice = resolveProvenance(body('Agent: harness'), PERSONAS);
    expect(twice).toEqual(once);
    expect(twice.kind).toBe('ok');
  });
});

// The gate's entrypoint, not just its parser. Copilot raised on #62 that only
// resolveProvenance was covered, so input selection and the exit path — the parts that
// decide whether a required check passes — were unchecked, in a file outside tsconfig
// and biome. The logic moved into src/ and these cover it.
describe('checkProvenance — the exit path', () => {
  const deps = (files: Record<string, string> = {}) => ({
    personas: PERSONAS,
    readFile: (p: string) => {
      const v = files[p];
      if (v === undefined) throw new Error(`ENOENT: no such file or directory, open '${p}'`);
      return v;
    },
  });

  it('exits 0 on a trailer in the body', () => {
    const r = checkProvenance({ PR_BODY: 'Agent: harness' }, deps());
    expect(r.code).toBe(0);
    expect(r.out).toContain('provenance ok');
  });

  it('exits 1 with no input at all, rather than passing vacuously', () => {
    expect(checkProvenance({}, deps()).code).toBe(1);
  });

  it('reads PR_COMMITS_FILE in preference to PR_COMMITS', () => {
    const r = checkProvenance(
      { PR_COMMITS_FILE: '/tmp/c', PR_COMMITS: 'Agent: marketer' },
      deps({ '/tmp/c': 'Agent: guardian' }),
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain('guardian');
  });

  it('falls back to PR_COMMITS when no file is given', () => {
    const r = checkProvenance({ PR_COMMITS: 'Agent: platform' }, deps());
    expect(r.code).toBe(0);
    expect(r.out).toContain('platform');
  });

  it('FAILS on an unreadable PR_COMMITS_FILE instead of treating it as empty', () => {
    // Treating a read error as empty input would pass any PR whose trailer lives only
    // in its commits, and would do it silently.
    const r = checkProvenance({ PR_COMMITS_FILE: '/tmp/gone' }, deps());
    expect(r.code).toBe(1);
    expect(r.out).toContain('could not read PR_COMMITS_FILE');
  });

  it('exits 1 on an unknown persona and names the valid ones', () => {
    const r = checkProvenance({ PR_BODY: 'Agent: wizard' }, deps());
    expect(r.code).toBe(1);
    expect(r.out).toContain('builder-server');
  });
});
