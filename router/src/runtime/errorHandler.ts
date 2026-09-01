// Error taxonomy per ARCHITECTURE.md §2.4.
//
// Maps SDK errors + prep-phase errors to a `SessionStatus` + a short reply
// message. Kept in one place so Phase 6d + Phase 7 (reply footer) + Phase 10
// (alerting) all agree on the categories.
//
// The router is deliberately conservative here — unknown errors default to
// `failed` (visible in the reply) rather than `interrupted_needs_resume`
// (silent retry) so silent-failure cases surface fast.

import type { SessionStatus } from '../types.js';

export type ErrorCategory =
  | 'sdk_transient' // Anthropic API 5xx / rate-limit — SDK should retry; if it bubbles up, we mark failed
  | 'sdk_config' // Anthropic API 4xx — request-shape / auth error — config bug
  | 'sdk_ratelimited'
  | 'mcp_crash'
  | 'unknown';

export type CategorizedError = {
  category: ErrorCategory;
  message: string;
  status: SessionStatus;
};

const SDK_TRANSIENT_HINTS = ['ECONNRESET', 'ETIMEDOUT', '502', '503', '504', 'overloaded'];
const SDK_RATELIMIT_HINTS = ['rate_limit', '429', 'quota'];
const SDK_CONFIG_HINTS = ['401', '403', '400', 'invalid_api_key', 'permission_denied'];
const MCP_HINTS = ['McpEnvResolutionError', 'mcp'];

export function categorizeError(err: Error): CategorizedError {
  const hay = `${err.name} ${err.message}`.toLowerCase();

  const matches = (needles: string[]): boolean =>
    needles.some((n) => hay.includes(n.toLowerCase()));

  if (matches(MCP_HINTS)) {
    return {
      category: 'mcp_crash',
      message: 'MCP server issue — session degraded',
      status: 'failed',
    };
  }
  if (matches(SDK_RATELIMIT_HINTS)) {
    return {
      category: 'sdk_ratelimited',
      message: 'SDK rate-limited — session interrupted; will resume',
      status: 'interrupted_needs_resume',
    };
  }
  if (matches(SDK_TRANSIENT_HINTS)) {
    return {
      category: 'sdk_transient',
      message: 'SDK transient error — session interrupted; will resume',
      status: 'interrupted_needs_resume',
    };
  }
  if (matches(SDK_CONFIG_HINTS)) {
    return {
      category: 'sdk_config',
      message: 'SDK config error — session failed',
      status: 'failed',
    };
  }
  return {
    category: 'unknown',
    message: `Unhandled error — ${err.message}`,
    status: 'failed',
  };
}

export function mapErrorToStatus(err: Error): SessionStatus {
  return categorizeError(err).status;
}
