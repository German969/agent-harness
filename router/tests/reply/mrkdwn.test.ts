import { describe, expect, it } from 'vitest';
import { toSlackMrkdwn } from '../../src/reply/mrkdwn.js';

describe('toSlackMrkdwn', () => {
  it('converts **bold** to *bold*', () => {
    expect(toSlackMrkdwn('hello **world** foo')).toBe('hello *world* foo');
  });

  it('converts __alt-bold__ to *bold*', () => {
    expect(toSlackMrkdwn('__foo__ bar')).toBe('*foo* bar');
  });

  it('converts markdown links to Slack link syntax', () => {
    expect(toSlackMrkdwn('see [docs](https://example.com/x) here')).toBe(
      'see <https://example.com/x|docs> here',
    );
  });

  it('converts headers to bold', () => {
    expect(toSlackMrkdwn('# Title\n\nbody')).toBe('*Title*\n\nbody');
    expect(toSlackMrkdwn('## Sub\nbody')).toBe('*Sub*\nbody');
  });

  it('wraps markdown tables in a code fence and drops the separator', () => {
    const md = [
      'prose above',
      '',
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
      '| 3 | 4 |',
      '',
      'below',
    ].join('\n');
    const out = toSlackMrkdwn(md);
    expect(out).toContain('```\n| A | B |\n| 1 | 2 |\n| 3 | 4 |\n```');
    expect(out).not.toContain('|---|---|');
  });

  it('does not touch content inside triple-backtick fences', () => {
    const md = 'plain **bold**\n\n```\n**not-bold-in-code**\n```\nafter';
    const out = toSlackMrkdwn(md);
    expect(out).toContain('*bold*');
    expect(out).toContain('**not-bold-in-code**');
  });

  it('does not touch content inside inline code', () => {
    const md = 'run `git commit -m "**msg**"` then continue';
    const out = toSlackMrkdwn(md);
    expect(out).toContain('`git commit -m "**msg**"`');
  });

  it('is idempotent — a second pass produces the same output', () => {
    const md = 'hi **world** [link](https://x.y)\n\n# H\n';
    const once = toSlackMrkdwn(md);
    expect(toSlackMrkdwn(once)).toBe(once);
  });

  it('leaves italics and single-star text alone', () => {
    // Standard MD uses *italic* as italic, but Slack renders it as bold.
    // The converter deliberately does NOT swap this — single-star is left as-is
    // because it already matches Slack's bold syntax after **→* conversion.
    expect(toSlackMrkdwn('*already-slack-bold*')).toBe('*already-slack-bold*');
  });
});
