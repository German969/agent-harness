import { describe, expect, it } from 'vitest';
import { branchName, sanitizeTaskId, worktreePath } from '../../src/workspace/index.js';

describe('sanitizeTaskId', () => {
  it('accepts standard IDs', () => {
    expect(sanitizeTaskId('eng-1234')).toBe('eng-1234');
    expect(sanitizeTaskId('pr-42')).toBe('pr-42');
    expect(sanitizeTaskId('ENG-9999')).toBe('ENG-9999');
    expect(sanitizeTaskId('feature.branch')).toBe('feature.branch');
    expect(sanitizeTaskId('scheduled:harness-monthly')).toBe('scheduled:harness-monthly');
  });

  it('rejects empty', () => {
    expect(() => sanitizeTaskId('')).toThrow('task_id_empty');
  });

  it('rejects path traversal chars', () => {
    expect(() => sanitizeTaskId('../etc')).toThrow('task_id_leading_dot');
    expect(() => sanitizeTaskId('a/b')).toThrow('task_id_invalid_chars');
    expect(() => sanitizeTaskId('a\\b')).toThrow('task_id_invalid_chars');
  });

  it('rejects reserved values', () => {
    expect(() => sanitizeTaskId('.')).toThrow('task_id_reserved');
    expect(() => sanitizeTaskId('..')).toThrow('task_id_reserved');
  });

  it('rejects leading dot (hidden files)', () => {
    expect(() => sanitizeTaskId('.env')).toThrow('task_id_leading_dot');
  });

  it('rejects too-long IDs', () => {
    expect(() => sanitizeTaskId('x'.repeat(129))).toThrow('task_id_too_long');
  });

  it('rejects control chars + spaces', () => {
    expect(() => sanitizeTaskId('has space')).toThrow('task_id_invalid_chars');
    expect(() => sanitizeTaskId('null\x00byte')).toThrow('task_id_invalid_chars');
  });
});

describe('worktreePath', () => {
  it('produces absolute path under root', () => {
    const p = worktreePath('/var/lib/agents/worktrees', 'guardian', 'pr-42');
    expect(p).toBe('/var/lib/agents/worktrees/guardian/pr-42');
  });

  it('rejects escape attempts even if sanitize somehow passes', () => {
    // sanitize catches '..' first, but the belt-and-suspenders check would too.
    expect(() => worktreePath('/root', 'guardian', '..')).toThrow();
  });

  it('handles trailing-slash-free root', () => {
    const p = worktreePath('/var/lib/agents/worktrees/', 'strategist', 'eng-1');
    expect(p).toBe('/var/lib/agents/worktrees/strategist/eng-1');
  });
});

describe('branchName', () => {
  it('follows the agent/<agent>/<task-id> convention', () => {
    expect(branchName('builder-server', 'eng-1234')).toBe('agent/builder-server/eng-1234');
    expect(branchName('harness', 'debug-msg_01')).toBe('agent/harness/debug-msg_01');
  });

  it('rejects invalid task_id', () => {
    expect(() => branchName('guardian', 'has space')).toThrow();
  });
});
