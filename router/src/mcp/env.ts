// Resolve `${VAR}` references in mcp.json env / headers blocks using
// session-scoped secrets.
//
// Two shapes handled:
//   env:     { "LINEAR_API_KEY": "${LINEAR_TOKEN}" }         (whole-string)
//   headers: { "Authorization": "Bearer ${GITHUB_TOKEN}" }   (embedded)
//
// Whole-string placeholders map 1:1 to a session env var. Embedded placeholders
// are substituted in place (allows `Bearer ...`, prefixes, etc.).

import type { SessionEnv } from '../secrets/types.js';
import { McpEnvResolutionError } from './types.js';

const PLACEHOLDER_ANYWHERE = /\$\{([A-Z][A-Z0-9_]*)\}/g;

/**
 * Resolve every `${VAR}` occurrence in an mcp.json env or headers block.
 *
 * Throws `McpEnvResolutionError` on the first missing `${VAR}` — do not silently
 * emit an empty string (that would spawn an MCP with a broken credential or
 * send a request with a missing Authorization header).
 */
export function resolveMcpEnv(
  serverName: string,
  envBlock: Record<string, string>,
  sessionEnv: SessionEnv,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, template] of Object.entries(envBlock)) {
    out[key] = substitutePlaceholders(serverName, key, template, sessionEnv);
  }
  return out;
}

function substitutePlaceholders(
  serverName: string,
  key: string,
  template: string,
  sessionEnv: SessionEnv,
): string {
  // .replace with a function callback lets us look up each ${VAR} independently
  // and surface a specific missing-var error via a sentinel throw.
  let missing: string | undefined;
  const result = template.replace(PLACEHOLDER_ANYWHERE, (_match, varName: string) => {
    const value = sessionEnv[varName];
    if (value === undefined) {
      missing = varName;
      return '';
    }
    return value;
  });
  if (missing) throw new McpEnvResolutionError(serverName, key, missing);
  return result;
}

/**
 * Minimal env that MCP children inherit from the router process so tools like
 * `npx`, `node`, and standard binaries resolve. Kept narrow — MCPs should only
 * see credentials + these baseline paths, never the router's own secrets.
 *
 * Used by runtime/sdkCall.ts when building the configs the Agent SDK spawns from.
 */
export function pickChildBaseEnv(): Record<string, string> {
  const base: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'NODE_PATH', 'LANG', 'LC_ALL']) {
    const v = process.env[key];
    if (v !== undefined) base[key] = v;
  }
  return base;
}
