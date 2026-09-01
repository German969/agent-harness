// Hook handler API.
// Per router/ARCHITECTURE.md §2.11.
//
// Every hook command implements this signature:
//     handler(config, ctx) → Promise<HookResult>
//
// The orchestrator invokes handlers in the order they appear in settings.json's
// hooks arrays, aggregating results per phase (SessionStart / PreToolUse / SessionEnd).

import type { Logger } from 'pino';
import type { HookEntry } from '../config/settingsSchema.js';
import type { AlertPoster } from '../observability/alerts.js';
import type { Db } from '../state/db.js';
import type { AgentId, SessionStatus, SkillId, TriggerKind } from '../types.js';

/**
 * Per-session context threaded through every hook. The orchestrator
 * constructs this before running the SessionStart hooks and re-uses it
 * across all phases in the same session.
 */
export type SessionContext = {
  agent: AgentId;
  skill?: SkillId | undefined;
  sessionId: number;
  claudeSessionId?: string | undefined;

  /** Absolute path to the session's git worktree (undefined for read-only sessions). */
  workspaceDir?: string | undefined;

  /** Trigger metadata for placeholder resolution + reply routing. */
  trigger: {
    kind: TriggerKind;
    provider?: 'github' | 'linear' | 'slack' | undefined;
    thread_key?: string | undefined;
    message?: string | undefined;
    /** Classifier match reason (e.g. 'explicit_mention'). Used to gate
     *  human-command-only capabilities like Linear mutation tools. */
    match_reason?: string | undefined;
  };

  /** Session-scoped env (secrets from Infisical + non-secret extras). Read-only for hooks. */
  env: Readonly<Record<string, string>>;

  /** Alert channel for a hook whose failure is silent but consequential — today
   *  only a failed push of `dev-team-state`, which means the fleet's memory did
   *  not reach origin. Optional: tests and bare boots run without one. */
  alertPoster?: AlertPoster | undefined;

  /** Path to the dev-team repo root. Loader hooks resolve `<target-project>` here. */
  devTeamRoot: string;

  /** Path to the target-project repo. Used to resolve `<target-project>/...` paths. */
  targetProjectRoot: string;

  /** The project name (for `${PROJECT}` interpolation). */
  projectName: string;

  db: Db;
  log: Logger;
};

/**
 * A hook's returned value. Different phases produce different HookResult kinds:
 *   - SessionStart:   `context` (injectable into the SDK call) or `gate` (refuse session)
 *   - PreToolUse:     `allow` or `deny`
 *   - PostToolUse:    `side-effect` (e.g. lint ran)
 *   - SessionEnd:     `side-effect` (commit, post, cleanup) — may cascade PR creation
 *
 * Errors are represented via `{ kind: 'error' }` rather than throwing, so the
 * orchestrator can decide whether to abort the whole hook chain or continue.
 */
export type HookResult =
  | { kind: 'context'; content: string; tag?: string }
  | { kind: 'gate'; reason: string; message: string }
  | { kind: 'allow' }
  | { kind: 'deny'; message: string }
  | { kind: 'side-effect'; summary: string; data?: Record<string, unknown> }
  | { kind: 'error'; error: Error };

/** A handler for one hook command. */
export type HookHandler = (config: HookEntry, ctx: SessionContext) => Promise<HookResult>;

/**
 * Per-tool-call context passed to PreToolUse hooks. Different shape from
 * SessionContext because these hooks receive info about the specific tool
 * invocation the SDK is about to make.
 */
export type ToolCallContext = SessionContext & {
  tool: string;
  /** Best-effort action verb extracted from tool name (e.g. 'publish', 'send'). */
  action?: string | undefined;
  /** Raw tool arguments (structure varies by tool). */
  input: unknown;
};

export type ToolCallHookHandler = (config: HookEntry, ctx: ToolCallContext) => Promise<HookResult>;

/** Aggregate result across a phase of hooks (multiple entries in settings.json). */
export type PhaseResult = {
  contexts: Array<{ content: string; tag?: string }>;
  sideEffects: Array<{ summary: string; data?: Record<string, unknown> }>;
  gate?: { reason: string; message: string };
  deny?: { message: string };
  errors: Array<{ commandIndex: number; error: Error }>;
};

/** A hook config with a resolved `command` field. */
export type ResolvedHookEntry = HookEntry & { command: string };

/** Type-guard: does this entry have a runnable command? */
export function isResolvedHookEntry(e: HookEntry): e is ResolvedHookEntry {
  return typeof e.command === 'string' && e.command.length > 0;
}

// Re-export SessionStatus for consumers that build sessions from hook results.
export type { SessionStatus };
