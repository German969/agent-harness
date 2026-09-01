import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type LinearOAuthCreds,
  type LinearTokenFetch,
  getLinearAccessToken,
  resetLinearOAuthInFlightForTests,
} from '../../src/linear/oauthToken.js';
import { type Db, applyMigrations, openDb } from '../../src/state/index.js';

const creds: LinearOAuthCreds = {
  clientId: 'cid',
  clientSecret: 'csec',
  seedRefreshToken: 'seed-refresh',
};

let db: Db;

beforeEach(() => {
  db = openDb({ path: ':memory:' });
  applyMigrations(db);
  resetLinearOAuthInFlightForTests();
});
afterEach(() => db.close());

/** A fetch that records the refresh_token it was called with and returns a rotated one. */
function recordingFetch(seq: Array<{ access: string; refresh: string; expiresIn: number }>): {
  fetchToken: LinearTokenFetch;
  calls: Array<Record<string, string>>;
} {
  const calls: Array<Record<string, string>> = [];
  let i = 0;
  const fetchToken: LinearTokenFetch = async (body) => {
    calls.push(Object.fromEntries(body.entries()));
    const step = seq[Math.min(i, seq.length - 1)];
    i += 1;
    if (!step) throw new Error('no fetch step');
    return { access_token: step.access, refresh_token: step.refresh, expires_in: step.expiresIn };
  };
  return { fetchToken, calls };
}

describe('getLinearAccessToken', () => {
  it('refreshes with the seed token on an empty DB and persists rotation', async () => {
    const { fetchToken, calls } = recordingFetch([
      { access: 'access-1', refresh: 'rot-1', expiresIn: 86400 },
    ]);
    const token = await getLinearAccessToken(db, creds, { fetchToken, now: () => 1_000 });
    expect(token).toBe('access-1');
    // used the seed refresh token, standard OAuth params
    expect(calls[0]).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'seed-refresh',
      client_id: 'cid',
      client_secret: 'csec',
    });
    const row = db.prepare('SELECT * FROM linear_oauth WHERE id = 1').get() as {
      access_token: string;
      refresh_token: string;
      expires_at: number;
    };
    expect(row.access_token).toBe('access-1');
    expect(row.refresh_token).toBe('rot-1'); // rotated token persisted
    expect(row.expires_at).toBe(1_000 + 86400 * 1000);
  });

  it('returns the cached token without refreshing while it is still valid', async () => {
    const { fetchToken, calls } = recordingFetch([
      { access: 'access-1', refresh: 'rot-1', expiresIn: 86400 },
    ]);
    await getLinearAccessToken(db, creds, { fetchToken, now: () => 1_000 });
    resetLinearOAuthInFlightForTests();
    // Well within validity → no second fetch.
    const token = await getLinearAccessToken(db, creds, { fetchToken, now: () => 5_000 });
    expect(token).toBe('access-1');
    expect(calls).toHaveLength(1);
  });

  it('refreshes when near expiry using the DB-rotated token, not the seed', async () => {
    const { fetchToken, calls } = recordingFetch([
      { access: 'access-1', refresh: 'rot-1', expiresIn: 100 },
      { access: 'access-2', refresh: 'rot-2', expiresIn: 100 },
    ]);
    await getLinearAccessToken(db, creds, { fetchToken, now: () => 0 });
    resetLinearOAuthInFlightForTests();
    // Now past (expiry - skew): 100s token, skew 120s → already needs refresh.
    const token = await getLinearAccessToken(db, creds, { fetchToken, now: () => 50_000 });
    expect(token).toBe('access-2');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.refresh_token).toBe('rot-1'); // used the rotated token from step 1
  });

  it('single-flights concurrent refreshes into one fetch', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let fetchCount = 0;
    const fetchToken: LinearTokenFetch = async () => {
      fetchCount += 1;
      await gate;
      return { access_token: 'access-1', refresh_token: 'rot-1', expires_in: 86400 };
    };
    const p1 = getLinearAccessToken(db, creds, { fetchToken, now: () => 0 });
    const p2 = getLinearAccessToken(db, creds, { fetchToken, now: () => 0 });
    const p3 = getLinearAccessToken(db, creds, { fetchToken, now: () => 0 });
    release();
    const [a, b, c] = await Promise.all([p1, p2, p3]);
    expect([a, b, c]).toEqual(['access-1', 'access-1', 'access-1']);
    expect(fetchCount).toBe(1);
  });

  it('propagates a refresh failure (so the caller can fall back / surface it)', async () => {
    const fetchToken: LinearTokenFetch = async () => {
      throw new Error('HTTP 400: invalid_grant');
    };
    await expect(getLinearAccessToken(db, creds, { fetchToken, now: () => 0 })).rejects.toThrow(
      /invalid_grant/,
    );
  });
});
