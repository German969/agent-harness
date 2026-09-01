// Types for the MCP lifecycle.
//
// The router does NOT spawn MCP children. The Claude Agent SDK owns their whole
// lifecycle: runtime/sdkCall.ts resolves each server's config (command, args, env
// placeholders) and the SDK spawns, talks to, and terminates the child itself.
// The router's job is limited to resolving configuration.

/**
 * Error raised when env-var resolution fails (unknown ${VAR}).
 * Deliberately not a soft failure — a missing secret is a misconfiguration and the
 * session should refuse rather than silently boot an MCP with a broken credential.
 */
export class McpEnvResolutionError extends Error {
  override readonly name = 'McpEnvResolutionError';
  constructor(
    public readonly server: string,
    public readonly envKey: string,
    public readonly missingVar: string,
  ) {
    super(
      `MCP env resolution failed for server "${server}" env "${envKey}": no session env var "${missingVar}"`,
    );
  }
}
