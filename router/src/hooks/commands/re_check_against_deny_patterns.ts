// PreToolUse hook — shape: `{ tool: 'Bash', re_check_against_deny_patterns: true }`
//
// Platform's production-safety backstop, and the reason it needs one. Its config
// says it plainly: "The deny patterns above are the technical enforcement. If a
// command tries to bypass — e.g. constructing the deny-listed string at runtime —
// this hook re-checks the final invocation."
//
// The gap is real and does not need an adversary to hit. `permissions.deny` becomes
// the SDK's `disallowedTools`, whose Bash rules are PREFIX rules: `Bash(terraform
// apply:*)` matches a command that STARTS WITH `terraform apply`. So
//
//     terraform apply                      → blocked
//     git status && terraform apply        → NOT blocked (starts with `git status`)
//     sh -c "terraform apply"              → NOT blocked (starts with `sh`)
//     terraform "app"ly                    → NOT blocked (not the literal prefix)
//
// Platform has 63 such rules covering terraform apply/destroy/import/taint and the
// rest of the production-mutation surface, and it is the one agent whose blast
// radius is real infrastructure. This hook re-reads those same rules and applies
// them to every segment of the final command rather than to its first word.
//
// It reuses the agent's OWN deny list rather than taking patterns of its own: two
// lists would drift, and the whole point is to enforce what the config already
// says. Best-effort by construction — a command whose text cannot be resolved
// (`eval $CMD`) is allowed, because this is defence in depth behind the SDK rule,
// not a replacement for it. Over-blocking would be its own outage.

import { loadAgentConfig } from '../../config/agentLoader.js';
import type { HookResult, ToolCallContext, ToolCallHookHandler } from '../types.js';

type ReCheckConfig = {
  tool?: string | string[];
  re_check_against_deny_patterns?: boolean;
  on_block_message?: string;
  message?: string;
};

export const reCheckAgainstDenyPatternsHandler: ToolCallHookHandler = async (
  config,
  ctx,
): Promise<HookResult> => {
  const cfg = config as ReCheckConfig;
  if (cfg.re_check_against_deny_patterns !== true) return { kind: 'allow' };
  if (!toolMatches(cfg.tool, ctx.tool)) return { kind: 'allow' };

  const command = extractCommand(ctx.input);
  if (!command) return { kind: 'allow' };

  let prefixes: string[];
  try {
    const { permissions } = loadAgentConfig(ctx.agent, { devTeamRoot: ctx.devTeamRoot }).settings;
    prefixes = bashDenyPrefixes(permissions.deny);
  } catch (err) {
    // A config that will not load is a separate problem with its own reporting.
    // Failing open matches the rest of this hook: the SDK rule is still in force.
    ctx.log.warn(
      { agent: ctx.agent, err: (err as Error).message },
      're_check_against_deny_patterns: could not load deny list; skipped',
    );
    return { kind: 'allow' };
  }
  if (prefixes.length === 0) return { kind: 'allow' };

  for (const segment of commandSegments(command)) {
    const normalized = normalize(segment);
    if (!normalized) continue;
    for (const prefix of prefixes) {
      if (normalized === prefix || normalized.startsWith(`${prefix} `)) {
        ctx.log.info(
          { agent: ctx.agent, prefix, segment },
          're_check_against_deny_patterns: denied a command the prefix rule would have missed',
        );
        return {
          kind: 'deny',
          message:
            cfg.on_block_message ??
            cfg.message ??
            `🛑 This command runs \`${prefix}\`, which is on this agent's deny list.`,
        };
      }
    }
  }
  return { kind: 'allow' };
};

/**
 * The command prefixes from `Bash(...)` entries in the agent's deny list.
 * `Bash(terraform apply:*)` → `terraform apply`. Non-Bash denials are the SDK's
 * job (they match on tool name, which needs no re-check).
 */
export function bashDenyPrefixes(deny: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of deny) {
    const m = /^Bash\((.+)\)$/.exec(entry);
    if (!m?.[1]) continue;
    const prefix = normalize(m[1].replace(/:\*$/, ''));
    if (prefix) out.push(prefix);
  }
  return out;
}

/**
 * Every command the shell would actually run, not just the first one. Splits on
 * the separators that chain commands and unwraps `$(...)`, backticks, and a
 * `-c "..."` payload so a nested invocation is checked on its own merits.
 */
export function commandSegments(command: string): string[] {
  const out: string[] = [];
  const queue = [command];
  // Bounded so a pathological nesting cannot spin here.
  for (let guard = 0; queue.length > 0 && guard < 200; guard++) {
    const current = queue.shift() as string;
    for (const part of current.split(/\s*(?:&&|\|\||[;|\n])\s*/)) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      out.push(trimmed);
      // `sh -c "..."` / `bash -c '...'` — the payload is a command in its own right.
      const dashC = /\B-c\s+(['"])([\s\S]*?)\1/.exec(trimmed);
      if (dashC?.[2]) queue.push(dashC[2]);
      // Command substitution.
      for (const m of trimmed.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
        const inner = m[1] ?? m[2];
        if (inner?.trim()) queue.push(inner);
      }
    }
  }
  return out;
}

/**
 * Collapse a segment to the form a prefix rule is written in: quote characters
 * dropped so `terraform "app"ly` reads as `terraform apply`, leading `env`-style
 * assignments and `sudo` stripped, whitespace collapsed.
 *
 * Dropping quotes cannot create a false positive on its own: `echo "terraform
 * apply"` still begins with `echo`, and these are prefix comparisons.
 */
function normalize(segment: string): string {
  let s = segment
    .replace(/['"\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // `sudo terraform apply`, `FOO=1 terraform apply` — the rule is written against
  // the program being run, not the way it was reached.
  for (;;) {
    const stripped = s.replace(/^(?:sudo(?:\s+-\S+)*|[A-Za-z_][A-Za-z0-9_]*=\S*)\s+/, '');
    if (stripped === s) break;
    s = stripped;
  }
  return s;
}

function extractCommand(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const command = (input as Record<string, unknown>).command;
  return typeof command === 'string' && command.trim() ? command : undefined;
}

function toolMatches(cfgTool: string | string[] | undefined, actual: string): boolean {
  if (cfgTool === undefined || cfgTool === '*') return true;
  const list = Array.isArray(cfgTool) ? cfgTool : [cfgTool];
  return list.includes(actual);
}
