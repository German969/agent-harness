// PreToolUse hook — shape: `{ tool: ['WebFetch','WebSearch'], if_url_or_query_matches: [...], deny_always: true }`
//
// Marketer's "benchmarking is public-information only" gate: no fetching
// login-gated competitor content. It had no handler AND no inference branch —
// `inferCommand` explicitly excludes this shape from `block_if_command_matches`
// ("so we never over-block them"), which had the side effect that it never
// blocked them either. The config read as a policy; nothing enforced it.
//
// Matching is case-insensitive SUBSTRING, not regex, because the configured
// values are URL fragments (`/account/`, `/admin/`, `login`, `intranet`). As
// regexes their `.` and `/` would quietly mean something else, and a URL gate
// that matches more than it says is the failure mode to avoid here.
//
// Both the URL and the search query are checked: WebFetch carries `url`,
// WebSearch carries `query`, and the same rule covers "don't go there" and
// "don't go looking for it".

import type { HookResult, ToolCallContext, ToolCallHookHandler } from '../types.js';

type BlockIfUrlConfig = {
  tool?: string | string[];
  if_url_or_query_matches?: unknown;
  deny_always?: boolean;
  message?: string;
};

export const blockIfUrlMatchesHandler: ToolCallHookHandler = async (
  config,
  ctx,
): Promise<HookResult> => {
  const cfg = config as BlockIfUrlConfig;
  if (!toolMatches(cfg.tool, ctx.tool)) return { kind: 'allow' };

  const needles = (Array.isArray(cfg.if_url_or_query_matches) ? cfg.if_url_or_query_matches : [])
    .filter((n): n is string => typeof n === 'string' && n.length > 0)
    .map((n) => n.toLowerCase());
  if (needles.length === 0) return { kind: 'allow' };

  const haystack = urlAndQuery(ctx.input);
  if (!haystack) return { kind: 'allow' };

  for (const needle of needles) {
    if (haystack.includes(needle)) {
      ctx.log.info(
        { agent: ctx.agent, tool: ctx.tool, needle },
        'block_if_url_matches: denied a login-gated fetch',
      );
      return {
        kind: 'deny',
        message: cfg.message ?? `🛑 blocked by hook rule: URL or query contains "${needle}"`,
      };
    }
  }
  return { kind: 'allow' };
};

/** The lower-cased text a rule is checked against: the URL and/or the query. */
function urlAndQuery(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const rec = input as Record<string, unknown>;
  const parts = [rec.url, rec.query].filter((v): v is string => typeof v === 'string');
  return parts.length > 0 ? parts.join(' ').toLowerCase() : undefined;
}

function toolMatches(cfgTool: string | string[] | undefined, actual: string): boolean {
  if (cfgTool === undefined || cfgTool === '*') return true;
  const list = Array.isArray(cfgTool) ? cfgTool : [cfgTool];
  return list.includes(actual);
}
