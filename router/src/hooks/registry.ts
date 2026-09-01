// Hook handler registry.
// Central mapping: command name → handler function.
// Split into two maps because SessionStart/SessionEnd handlers take SessionContext
// while PreToolUse/PostToolUse handlers take ToolCallContext (extended with tool + input).

import { blockIfActionMatchesHandler } from './commands/block_if_action_matches.js';
import { blockIfCommandMatchesHandler } from './commands/block_if_command_matches.js';
import { blockIfPathMatchesHandler } from './commands/block_if_path_matches.js';
import { blockIfUrlMatchesHandler } from './commands/block_if_url_matches.js';
import { checkHandler } from './commands/check.js';
import { conditionalLoadHandler } from './commands/conditional_load.js';
import { gitCommitHandler } from './commands/git_commit.js';
import { gitCommitIfChangedHandler } from './commands/git_commit_if_changed.js';
import { formatAndLintHandler, lintAndFormatHandler } from './commands/lint_stubs.js';
import { loadHandler } from './commands/load.js';
import { reCheckAgainstDenyPatternsHandler } from './commands/re_check_against_deny_patterns.js';
import { testimonialPermissionCheckHandler } from './commands/testimonial_permission_check.js';
import { validateStructuredDataHandler } from './commands/validate_structured_data.js';
import { versionBumpOnlyHandler } from './commands/version_bump_only.js';
import type { HookHandler, ToolCallHookHandler } from './types.js';

/** Handlers for SessionStart + SessionEnd (SessionContext-based). */
export const sessionHandlers: Record<string, HookHandler> = {
  load: loadHandler,
  check: checkHandler,
  conditional_load: conditionalLoadHandler,
  git_commit: gitCommitHandler,
  git_commit_if_changed: gitCommitIfChangedHandler,
};

/** Handlers for PreToolUse + PostToolUse (ToolCallContext-based). */
export const toolCallHandlers: Record<string, ToolCallHookHandler> = {
  block_if_path_matches: blockIfPathMatchesHandler,
  block_if_action_matches: blockIfActionMatchesHandler,
  block_if_command_matches: blockIfCommandMatchesHandler,
  re_check_against_deny_patterns: reCheckAgainstDenyPatternsHandler,
  block_if_url_matches: blockIfUrlMatchesHandler,
  // `validate: <name>` shapes — inferCommand resolves the name straight through.
  version_bump_only: versionBumpOnlyHandler,
  testimonial_permission_check: testimonialPermissionCheckHandler,
  lint_and_format: lintAndFormatHandler,
  format_and_lint: formatAndLintHandler,
  validate_structured_data: validateStructuredDataHandler,
};

/**
 * Handlers that are registered but do nothing yet — they log their intent and
 * return. Named here so the fleet-config gate can tell "wired" from "wired to a
 * stub": a hook whose handler exists but no-ops is as absent as one with no
 * handler at all, and the agent config reads identically either way.
 *
 * Empty as of the PR that implemented lint_and_format / format_and_lint. Add a
 * name here the moment a placeholder handler is registered, not later.
 */
export const STUB_HANDLERS: ReadonlySet<string> = new Set<string>();

/**
 * Resolve a command name to a session-context handler.
 * Returns undefined for unknown commands (orchestrator will log + skip).
 */
export function getSessionHandler(command: string): HookHandler | undefined {
  return sessionHandlers[command];
}

/** Resolve a command name to a tool-call handler. */
export function getToolCallHandler(command: string): ToolCallHookHandler | undefined {
  return toolCallHandlers[command];
}

/**
 * A hook entry can have either `command: 'load'` (explicit) OR shape-based
 * inference (e.g. `{ tool: X, block_if_path_matches: [...] }` implies the
 * block_if_path_matches handler even without `command` set).
 *
 * Returns the resolved command name for a given entry, or undefined.
 */
export function inferCommand(entry: Record<string, unknown>): string | undefined {
  if (typeof entry.command === 'string') return entry.command;
  // Shape-based inference for tool-call hooks
  if ('block_if_path_matches' in entry) return 'block_if_path_matches';
  if ('block_if_action_matches' in entry) return 'block_if_action_matches';
  // Regex command gates (`patterns`/`pattern`) and flat tool denials (`deny_always`
  // with only a `tool` filter). The deny_always branch excludes shapes carrying a
  // condition key this handler does not evaluate (`if_url_or_query_matches`,
  // `if_content_matches_pattern`, `validate`) so we never over-block them.
  // Checked before the deny_always branch below, which excludes this shape so it
  // never over-blocks on the generic command haystack. That exclusion is why the
  // rule never fired at all until this handler existed.
  if ('if_url_or_query_matches' in entry) return 'block_if_url_matches';
  if ('patterns' in entry || 'pattern' in entry) return 'block_if_command_matches';
  if (
    entry.deny_always === true &&
    !('if_url_or_query_matches' in entry) &&
    !('if_content_matches_pattern' in entry) &&
    !('validate' in entry)
  ) {
    return 'block_if_command_matches';
  }
  // Platform's production-safety backstop. Checked before the `validate` branch
  // because the shape carries neither `patterns` nor `validate`.
  if (entry.re_check_against_deny_patterns === true) return 're_check_against_deny_patterns';
  if ('validate' in entry && typeof entry.validate === 'string') return String(entry.validate);
  return undefined;
}
