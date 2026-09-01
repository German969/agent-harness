// Turn `permissions.allow` into a real restriction.
//
// Until now it was not one. The SDK's `allowedTools` is a prompt-skip list — its
// own docs say "auto-allowed WITHOUT PROMPTING… to restrict which tools are
// available, use the `tools` option instead" — the router never set `tools`, and
// its canUseTool allows whatever no PreToolUse hook denies. So every built-in the
// CLI ships was available to every agent, whatever its config said.
//
// `tools` is the field that restricts, and it governs BUILT-IN tools only. MCP
// tools are configured by mcpServersConfig and gated separately (see
// linearGatedAllowed), so `mcp__*` entries are dropped here rather than passed
// through into a list that would not understand them.
//
// Two deliberate safety choices, because this is the first change in this series
// that REMOVES capability from a running agent:
//
//   - An unrecognised non-MCP name is passed through, not filtered out. A stale
//     hard-coded set of "known built-ins" here would silently withhold a tool the
//     day the CLI adds one, and a tool that vanishes without a message is the
//     exact failure this whole series has been chasing. The SDK ignores a name it
//     does not know; dropping a real one breaks an agent.
//   - An EMPTY result never sets `tools`. `tools: []` means "disable all built-in
//     tools" — an agent with a malformed or empty allow list would be left unable
//     to read a file, and failing open to today's behaviour is the better error.

/**
 * The built-in tool names implied by an agent's `permissions.allow`.
 *
 * Permission rules carry an argument filter (`Bash(git log:*)`) while `tools`
 * takes bare names, so each entry is reduced to its leading identifier and
 * de-duplicated — `Bash(git log:*)` and `Bash(git diff:*)` are one `Bash`.
 *
 * Returns undefined when nothing usable is left, meaning "do not restrict".
 */
export function builtinToolsFrom(allow: readonly string[]): string[] | undefined {
  const names = new Set<string>();
  for (const entry of allow) {
    // `_`-prefixed entries are the inline comments these config arrays carry.
    if (entry.startsWith('_') || entry.startsWith('mcp__')) continue;
    const base = /^([A-Za-z][A-Za-z0-9]*)/.exec(entry)?.[1];
    if (base) names.add(base);
  }
  return names.size > 0 ? [...names].sort() : undefined;
}
