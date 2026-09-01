// Linear actor=app OAuth token manager.
//
// Linear's actor=app access tokens live 24h; you renew them with the rotating
// refresh_token (each refresh returns a NEW refresh_token; Linear allows a 30-min
// replay grace for network errors). Personal API keys (lin_api_…) don't apply here.
//
// This module keeps ONE shared token (all agents use one OAuth app, distinguished by
// createAsUser) in the router's SQLite state: it returns the cached access token when
// it's still valid, and otherwise refreshes — persisting the rotated refresh token so
// it survives restarts. A process-level single-flight guard means concurrent sessions
// share one refresh rather than racing the single-use refresh token.

import type { Logger } from 'pino';
import type { Db } from '../state/index.js';

export type LinearOAuthCreds = {
  clientId: string;
  clientSecret: string;
  /** Initial refresh token (from Infisical); used only until the DB has a rotated one. */
  seedRefreshToken: string;
};

type TokenResponse = { access_token: string; refresh_token: string; expires_in: number };

/** Injectable token-endpoint call — real impl POSTs to Linear; tests fake it. */
export type LinearTokenFetch = (body: URLSearchParams) => Promise<TokenResponse>;

export type GetTokenOpts = {
  now?: () => number;
  fetchToken?: LinearTokenFetch;
  tokenUrl?: string;
  log?: Logger;
};

const REFRESH_SKEW_MS = 120_000; // renew 2 min before actual expiry
const DEFAULT_TOKEN_URL = 'https://api.linear.app/oauth/token';

type Row = { access_token: string; refresh_token: string; expires_at: number };

/** Process-level single-flight: one in-progress refresh shared by all callers. */
let inFlight: Promise<string> | null = null;

/**
 * Return a valid Linear access token, refreshing (and persisting rotation) if the
 * cached one is missing or within {@link REFRESH_SKEW_MS} of expiry.
 */
export async function getLinearAccessToken(
  db: Db,
  creds: LinearOAuthCreds,
  opts: GetTokenOpts = {},
): Promise<string> {
  const now = opts.now ?? Date.now;
  const row = readRow(db);
  if (row && row.expires_at > now() + REFRESH_SKEW_MS) return row.access_token;

  if (!inFlight) {
    const refreshToken = row?.refresh_token ?? creds.seedRefreshToken;
    inFlight = refresh(db, creds, refreshToken, opts).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function refresh(
  db: Db,
  creds: LinearOAuthCreds,
  refreshToken: string,
  opts: GetTokenOpts,
): Promise<string> {
  const now = opts.now ?? Date.now;
  const fetchToken = opts.fetchToken ?? defaultFetch(opts.tokenUrl ?? DEFAULT_TOKEN_URL);
  const res = await fetchToken(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    }),
  );
  const at = now();
  writeRow(db, {
    access_token: res.access_token,
    refresh_token: res.refresh_token,
    expires_at: at + res.expires_in * 1000,
    updated_at: at,
  });
  opts.log?.info({ expiresIn: res.expires_in }, 'linear oauth: refreshed access token');
  return res.access_token;
}

function defaultFetch(url: string): LinearTokenFetch {
  return async (body) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const detail = text ? `: ${text.slice(0, 200)}` : '';
      const hint = 'the refresh token may be expired/revoked; re-authorize the Linear OAuth app';
      throw new Error(`linear oauth refresh HTTP ${res.status}${detail} — ${hint}`);
    }
    const json = (await res.json()) as Partial<TokenResponse>;
    if (
      typeof json.access_token !== 'string' ||
      typeof json.refresh_token !== 'string' ||
      typeof json.expires_in !== 'number'
    ) {
      throw new Error(
        'linear oauth refresh: response missing access_token/refresh_token/expires_in',
      );
    }
    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_in: json.expires_in,
    };
  };
}

function readRow(db: Db): Row | undefined {
  return db
    .prepare('SELECT access_token, refresh_token, expires_at FROM linear_oauth WHERE id = 1')
    .get() as Row | undefined;
}

function writeRow(db: Db, row: Row & { updated_at: number }): void {
  db.prepare(
    `INSERT INTO linear_oauth (id, access_token, refresh_token, expires_at, updated_at)
     VALUES (1, @access_token, @refresh_token, @expires_at, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at`,
  ).run(row);
}

/** Test-only: clear the single-flight guard between cases. */
export function resetLinearOAuthInFlightForTests(): void {
  inFlight = null;
}
