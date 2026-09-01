// Public surface of the MCP lifecycle module.
//
// Configuration only — the Agent SDK spawns and owns MCP children (see types.ts).

export { pickChildBaseEnv, resolveMcpEnv } from './env.js';
export { McpEnvResolutionError } from './types.js';
