// InfisicalSecretProvider — production secret backend.
//
// Authenticates a machine identity via Universal Auth on first use, then reads
// secrets via the SDK. Values are cached in-memory with a short TTL so a
// session's back-to-back fetches don't hammer Infisical, but rotations
// propagate within one TTL window without a restart.
//
// Auth failures (expired token) trigger a single re-auth + retry.

import { InfisicalSDK } from '@infisical/sdk';
import { SecretNotFoundError } from './env-provider.js';
import type { SecretProvider } from './types.js';

export type InfisicalProviderConfig = {
  siteUrl: string;
  projectId: string;
  environment: string; // e.g. 'dev' | 'staging' | 'prod'
  clientId: string;
  clientSecret: string;
  /** In-memory value cache TTL. Default 5 min — long enough to coalesce
   *  a session's fetches, short enough for rotations to land next session. */
  cacheTtlMs?: number;
};

type CacheEntry = { value: string; expiresAt: number };

export class InfisicalSecretProvider implements SecretProvider {
  readonly kind = 'infisical' as const;

  private readonly cfg: InfisicalProviderConfig;
  private readonly cache = new Map<string, CacheEntry>();
  private client: InfisicalSDK | undefined;
  private loginInFlight: Promise<void> | undefined;

  constructor(cfg: InfisicalProviderConfig) {
    this.cfg = cfg;
  }

  async getSecret(name: string): Promise<string> {
    const now = Date.now();
    const cached = this.cache.get(name);
    if (cached && cached.expiresAt > now) return cached.value;

    const value = await this.fetch(name);
    const ttl = this.cfg.cacheTtlMs ?? 5 * 60 * 1000;
    this.cache.set(name, { value, expiresAt: now + ttl });
    return value;
  }

  private async fetch(name: string, retried = false): Promise<string> {
    await this.ensureAuthenticated();
    const client = this.client;
    if (!client) throw new Error('InfisicalSecretProvider: client not initialized');

    try {
      const secret = await client.secrets().getSecret({
        environment: this.cfg.environment,
        projectId: this.cfg.projectId,
        secretName: name,
        viewSecretValue: true,
      });
      if (typeof secret.secretValue !== 'string' || secret.secretValue === '') {
        throw new SecretNotFoundError(name, 'infisical');
      }
      return secret.secretValue;
    } catch (err) {
      if (!retried && isAuthError(err)) {
        // Token expired — drop the client and retry once with a fresh login.
        this.client = undefined;
        return this.fetch(name, true);
      }
      if (isNotFoundError(err)) {
        throw new SecretNotFoundError(name, 'infisical');
      }
      throw err;
    }
  }

  private async ensureAuthenticated(): Promise<void> {
    if (this.client) return;
    if (this.loginInFlight) {
      await this.loginInFlight;
      return;
    }
    this.loginInFlight = (async () => {
      const client = new InfisicalSDK({ siteUrl: this.cfg.siteUrl });
      await client.auth().universalAuth.login({
        clientId: this.cfg.clientId,
        clientSecret: this.cfg.clientSecret,
      });
      this.client = client;
    })();
    try {
      await this.loginInFlight;
    } finally {
      this.loginInFlight = undefined;
    }
  }
}

function isAuthError(err: unknown): boolean {
  const status = readStatus(err);
  return status === 401 || status === 403;
}

function isNotFoundError(err: unknown): boolean {
  return readStatus(err) === 404;
}

function readStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  if (typeof e.status === 'number') return e.status;
  if (typeof e.statusCode === 'number') return e.statusCode;
  if (typeof e.response?.status === 'number') return e.response.status;
  return undefined;
}
