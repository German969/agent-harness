import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readableDirs } from '../../src/runtime/sdkCall.js';
import { mkCtx } from '../hooks/_rig.js';

let tmp: string;
let devTeamRoot: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'readable-dirs-'));
  devTeamRoot = join(tmp, 'dev-team');
  mkdirSync(devTeamRoot, { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('readableDirs', () => {
  it('includes the target project + dev-team-state when both are mounted', () => {
    const target = join(tmp, 'chatbots');
    const state = join(tmp, 'dev-team-state'); // sibling of devTeamRoot
    mkdirSync(target);
    mkdirSync(state);
    const dirs = readableDirs(mkCtx({ devTeamRoot, targetProjectRoot: target }));
    expect(dirs).toContain(target);
    expect(dirs).toContain(state);
  });

  it('omits an un-mounted repo instead of handing the SDK a dead path', () => {
    const target = join(tmp, 'not-cloned-yet'); // does not exist
    const dirs = readableDirs(mkCtx({ devTeamRoot, targetProjectRoot: target }));
    expect(dirs).not.toContain(target);
    // dev-team-state sibling also absent → nothing extra.
    expect(dirs).toEqual([]);
  });

  it('does not duplicate the dev-team root (cwd already covers it)', () => {
    // When targetProjectRoot falls back to devTeamRoot (no mount), it must not
    // appear as an additional directory.
    const dirs = readableDirs(mkCtx({ devTeamRoot, targetProjectRoot: devTeamRoot }));
    expect(dirs).not.toContain(devTeamRoot);
  });
});
