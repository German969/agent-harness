import { describe, expect, it } from 'vitest';
import { taskIdFromThreadKey } from '../../src/consumer/taskId.js';
import { sanitizeTaskId } from '../../src/workspace/paths.js';

describe('taskIdFromThreadKey', () => {
  it('collapses the colon in a Linear ticket key — git refs reject it', () => {
    expect(taskIdFromThreadKey('linear:IRS-46')).toBe('linear-IRS-46');
  });

  it('collapses the slashes in a GitHub thread key', () => {
    expect(taskIdFromThreadKey('github:German969/chatbots/pr/12')).toBe(
      'github-German969-chatbots-pr-12',
    );
  });

  it('returns undefined when there is no thread to key on', () => {
    expect(taskIdFromThreadKey(undefined)).toBeUndefined();
    expect(taskIdFromThreadKey('')).toBeUndefined();
  });

  it('never produces something git would reject as a branch name', () => {
    // The id becomes `agent/<agent>/<id>` via branchName. A colon there is fatal:
    // git refuses the ref and worktree acquisition fails at runtime.
    for (const key of ['linear:IRS-46', 'github:o/r/pr/1', 'slack:C1/100.0']) {
      expect(taskIdFromThreadKey(key)).not.toContain(':');
    }
  });

  it('never produces something sanitizeTaskId would reject', () => {
    // The two functions have to agree or acquisition fails at runtime with a
    // path error instead of here.
    const keys = [
      'linear:IRS-46',
      'github:German969/chatbots/pr/12',
      'github:o/r/issue/9',
      'slack:C-planning/100.0',
      '...leading dots',
      'a'.repeat(300),
    ];
    for (const key of keys) {
      const id = taskIdFromThreadKey(key);
      if (id === undefined) continue;
      expect(() => sanitizeTaskId(id)).not.toThrow();
    }
  });

  it('is stable across every event about the same ticket', () => {
    // A label add and a later comment must land on ONE worktree, not two.
    expect(taskIdFromThreadKey('linear:IRS-46')).toBe(taskIdFromThreadKey('linear:IRS-46'));
  });
});
