// SdkClient — the narrow contract this runtime depends on for invoking Claude.
//
// The real Claude Agent SDK is not yet installed (Phase 13 wires @anthropic-ai/claude-agent-sdk).
// Rather than block Phase 6d, we define a minimal interface that mirrors the
// shape from ARCHITECTURE.md §2.4 and let tests inject mocks. When the SDK
// arrives, one adapter file bridges it to `SdkClient` — no other runtime code
// needs to change.

/** One partial text chunk emitted by the model during a turn. */
export type PartialChunk = { text: string };

/** Per-turn cost + token counts reported by the SDK.
 *  Anthropic bills three input categories separately (uncached, cache-write,
 *  cache-read); we track all three so the DB can attribute cost accurately. */
export type TurnCost = {
  input_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  cost_usd: number;
};

/** Tool-call description passed to the router's PreToolUse handler. */
export type ToolCallDescriptor = {
  tool: string;
  action?: string | undefined;
  input: unknown;
};

/** The router's PreToolUse decision (from the hook orchestrator). */
export type PreToolUseDecision = { kind: 'allow' } | { kind: 'deny'; message: string };

/** Post-turn decision — the runtime can cancel the session (e.g. per-job cap hit). */
export type TurnDecision = { kind: 'continue' } | { kind: 'cancel'; reason: string };

/** Terminal reason for the SDK session ending. */
export type SessionOutcome =
  | { kind: 'completed'; finalText: string; claudeSessionId?: string }
  | { kind: 'max_turns_reached'; finalText: string; claudeSessionId?: string }
  | { kind: 'cancelled'; reason: string; claudeSessionId?: string }
  | { kind: 'error'; error: Error; claudeSessionId?: string };

/**
 * Inputs to a single SDK invocation. Mirrors ARCHITECTURE.md §2.4's
 * `RuntimeInputs` — but narrowed to what the router actually constructs.
 */
export type SdkRunInputs = {
  /** The agent this session runs as — used e.g. to attribute in-process Linear
   *  actions via `createAsUser` so each agent's Linear writes read as itself. */
  agent?: string | undefined;
  /**
   * Called with the thread_key of any work artifact this session creates (today:
   * a Linear ticket). The consumer uses it to record who made the ticket, so the
   * loop guard can follow a chain across the thread boundary a new ticket creates.
   */
  onIssueCreated?: ((threadKey: string) => void) | undefined;
  model: string;
  systemPrompt: string;
  initialContext: Array<{ content: string; tag?: string }>;
  initialMessage: string;
  maxTurns: number;
  allowedTools: string[];
  deniedTools: string[];
  /** Restrict the session's BUILT-IN tools to this set (the SDK's `tools`).
   *  Undefined leaves the default set in place. See runtime/toolAllowlist.ts. */
  builtinTools?: string[] | undefined;
  thinkingBudget?: number | undefined;
  /**
   * Resolved MCP configs — stdio (command + args + env) or http (url + headers),
   * all placeholders already substituted. Adapters that spawn MCP children
   * themselves (Anthropic SDK) or connect to remote endpoints use this.
   */
  mcpServersConfig?: Record<
    string,
    | { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }
    | { type: 'http'; url: string; headers: Record<string, string> }
  >;
  /** Names of in-process (SDK-hosted) MCP servers the agent opted into via an
   *  `{ type: 'sdk' }` entry in its mcp.json (e.g. `github_gitdata`). The adapter
   *  instantiates the known ones in-process — they aren't spawned children. */
  inProcessMcp?: string[] | undefined;

  /** When true, the in-process Linear MCP also exposes the GATED mutation tier
   *  (move/milestone/reassign/due-date/close). Set only for a human-command
   *  session on an agent whose mcp.json linear entry declares `gated_mutations`.
   *  See linearMcp.ts + sdkCall.ts (linearGatedAllowed). */
  gatedLinearMutations?: boolean | undefined;

  /** Set to resume a prior Claude session; undefined starts a new one. */
  claudeSessionId?: string | undefined;
  /** Session-scoped env for the SDK's own process (e.g. ANTHROPIC_API_KEY). */
  env: Readonly<Record<string, string>>;
  /** Optional session logger — adapters can emit tool-call decisions and
   *  stream boundaries so `dtlog` surfaces what the SDK is actually doing. */
  log?: import('pino').Logger | undefined;
  /** Working directory the SDK's tools (Read/Grep/Glob/Bash) operate from.
   *  Defaults to the SDK's own process cwd (which for the router container is
   *  the install dir, not the dev-team repo). Set this to a mounted repo path. */
  cwd?: string | undefined;
  /** Extra readable directories exposed to the SDK's tools (e.g. the target
   *  project mount for agents whose primary cwd is the dev-team repo). */
  additionalDirectories?: string[] | undefined;
};

/** Callbacks the runtime plugs into the SDK's event stream. */
export type SdkCallbacks = {
  /** Streamed text output — pushed to the reply layer. */
  onPartial: (chunk: PartialChunk) => void;
  /** Fired before every tool call; the router's answer controls allow/deny. */
  onToolCall: (call: ToolCallDescriptor) => Promise<PreToolUseDecision>;
  /** Fired after every turn (model response + optional tool loop). */
  onTurnComplete: (turn: TurnCost) => Promise<TurnDecision> | TurnDecision;
};

/**
 * The narrow contract Phase 6d code depends on. Real SDK adapter or test mock
 * both implement this. `runSession` MUST NOT throw for expected error modes;
 * they should surface as `{ kind: 'error' }` outcomes so the runtime can map
 * them to session statuses without exception plumbing.
 */
export interface SdkClient {
  runSession(inputs: SdkRunInputs, callbacks: SdkCallbacks): Promise<SessionOutcome>;
  /** Provider identity for logging + tests. */
  readonly kind: 'placeholder' | 'anthropic' | 'mock';
}

/**
 * A placeholder implementation used when the real SDK isn't installed. Always
 * returns an error outcome — the runtime treats this as a config error (Phase 13
 * or explicit test-injection remains required to actually run sessions).
 */
export class PlaceholderSdkClient implements SdkClient {
  readonly kind = 'placeholder' as const;
  async runSession(): Promise<SessionOutcome> {
    return {
      kind: 'error',
      error: new Error(
        'SDK not installed: PlaceholderSdkClient is a stub. Install @anthropic-ai/claude-agent-sdk (Phase 13) or inject a mock SdkClient.',
      ),
    };
  }
}
