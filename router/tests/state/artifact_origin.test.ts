// artifact_origin — the cross-thread half of the loop guard.
//
// agent_chain finds a parent via findContinuation, which matches on thread_key,
// so it only ever links a hop INSIDE one thread. A ticket an agent creates is a
// new thread, so depth restarted at zero and an agent-created-ticket fan-out was
// unbounded. These are the storage primitives that close that.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Db,
  applyMigrations,
  createSession,
  findArtifactOrigin,
  openDb,
  recordArtifactOrigin,
} from '../../src/state/index.js';

describe('artifact_origin', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb({ path: ':memory:' });
    applyMigrations(db);
  });

  function mkSession(threadKey: string): number {
    return createSession(db, {
      agent: 'strategist',
      thread_key: threadKey,
      status: 'pending',
      triggered_by: 'webhook:linear',
      trigger_payload: {},
    });
  }

  it('records and finds the creating session', () => {
    const creator = mkSession('linear:IRS-46');
    recordArtifactOrigin(db, { thread_key: 'linear:IRS-47', session_id: creator, now: 1234 });

    const origin = findArtifactOrigin(db, 'linear:IRS-47');
    expect(origin).toEqual({
      thread_key: 'linear:IRS-47',
      session_id: creator,
      created_at: 1234,
    });
  });

  it('returns undefined for a ticket nobody recorded (i.e. a human made it)', () => {
    expect(findArtifactOrigin(db, 'linear:IRS-99')).toBeUndefined();
  });

  it('first writer wins — a later session cannot re-parent an existing ticket', () => {
    // The case this guards: an agent touches the same ticket in a second session
    // and calls create_issue again for it. Overwriting would rewrite the chain's
    // history and, in the worst case, point a chain at itself.
    const first = mkSession('linear:IRS-46');
    const second = mkSession('linear:IRS-48');
    recordArtifactOrigin(db, { thread_key: 'linear:IRS-47', session_id: first });
    recordArtifactOrigin(db, { thread_key: 'linear:IRS-47', session_id: second });

    expect(findArtifactOrigin(db, 'linear:IRS-47')?.session_id).toBe(first);
  });

  it('keys are exact — one ticket per row, no prefix matching', () => {
    const creator = mkSession('linear:IRS-46');
    recordArtifactOrigin(db, { thread_key: 'linear:IRS-4', session_id: creator });

    expect(findArtifactOrigin(db, 'linear:IRS-4')?.session_id).toBe(creator);
    expect(findArtifactOrigin(db, 'linear:IRS-47')).toBeUndefined();
  });
});
