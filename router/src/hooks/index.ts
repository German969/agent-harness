// Public surface of the hooks module.

export {
  contextVars,
  resolvePath,
  resolveVars,
} from './placeholder.js';
export {
  getSessionHandler,
  getToolCallHandler,
  inferCommand,
  sessionHandlers,
  toolCallHandlers,
} from './registry.js';
export { runSessionPhase, runToolCallPhase } from './orchestrator.js';
export type {
  HookHandler,
  HookResult,
  PhaseResult,
  SessionContext,
  ToolCallContext,
  ToolCallHookHandler,
  ResolvedHookEntry,
} from './types.js';
export { isResolvedHookEntry } from './types.js';
