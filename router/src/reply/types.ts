// Reply-layer types.
//
// The reply layer takes streamed text chunks from the SDK (onPartial) and
// pushes them back to the trigger surface (Slack thread, Linear comment,
// GitHub PR/issue comment). Batching per-provider avoids rate limits.

import type { AgentId, SkillId } from '../types.js';

/**
 * Where a session's output should be posted. Discriminated by provider so each
 * per-provider adapter knows exactly what it needs.
 */
export type ReplyTarget =
  | {
      provider: 'slack';
      /** Channel to post in. Required. */
      channel: string;
      /** Thread parent's ts, if replying inside a thread. */
      thread_ts?: string | undefined;
      /** Bot user token — normally injected from session env. */
      token: string;
    }
  | {
      provider: 'linear';
      /** Linear issue ID (uuid). */
      issue_id: string;
      /** Linear API token. */
      token: string;
    }
  | {
      provider: 'github';
      /** Owner (org or user). */
      owner: string;
      /** Repo name. */
      repo: string;
      /** Issue OR pull request number (they share the /issues/{n}/comments endpoint). */
      issue_number: number;
      /** GitHub token (app installation token or PAT). */
      token: string;
    };

/** One streaming text chunk from the SDK. */
export type StreamChunk = { text: string };

/**
 * Metadata used to build the session footer at completion.
 */
export type SessionFooter = {
  agent: AgentId;
  /** Display handle shown in the footer (e.g. `strategist-agent`, `guardian-bot`).
   *  Falls back to `<agent>-agent` if not provided. Populated from the identity's
   *  bot_username in prod. */
  handle?: string | undefined;
  skill?: SkillId | undefined;
  sessionId: number;
  /** Root of the continuation chain — the first session in this thread. When
   *  present, the footer displays this instead of `sessionId` so every message
   *  in the same thread shows the same number to the reader. */
  rootSessionId?: number | undefined;
  durationMs: number;
  costUsd: number;
  /**
   * How the session ended. Anything other than `completed` means the text above
   * is not a finished answer — it is whatever the agent had said when it was cut
   * off. Without this the reader cannot tell a truncated session from a finished
   * one, which is how a turn-limit stop reads as a deliberate reply.
   *
   * Mirrors runtime `SessionOutcome['kind']`, restated here so the reply layer
   * does not depend on the runtime layer.
   */
  outcome?: 'completed' | 'max_turns_reached' | 'cancelled' | 'error' | undefined;
  logLinkBase?: string | undefined; // e.g. "https://dev-team.example.com/sessions/"
};

/**
 * The narrow contract each per-provider reply client implements.
 * `send(text)` is expected to either create the message (on first call) or
 * edit the existing one (on subsequent calls) — implementations track their
 * own message identity across calls to the same client instance.
 */
export interface ReplyClient {
  readonly provider: 'slack' | 'linear' | 'github';
  send(text: string): Promise<void>;
  /** Terminal send — final content + footer, flushes any pending batch. */
  finalize(text: string): Promise<void>;
}

/**
 * Fetch-like function injected into per-provider clients so tests can mock
 * HTTP calls without pulling in nock/undici mock agents.
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
