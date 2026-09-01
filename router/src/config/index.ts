// Public surface of the config module.

export {
  loadAgentConfig,
  clearAgentConfigCache,
  agentConfigCacheSize,
  AgentConfigError,
  type AgentConfig,
  type LoadOptions,
} from './agentLoader.js';
export {
  AgentSettingsSchema,
  CostCapSchema,
  ThinkingSchema,
  PermissionsSchema,
  WriteScopeSchema,
  HooksSchema,
  HookEntrySchema,
  McpServerSchema,
  McpConfigSchema,
  activeServers,
  serverAllowsSkill,
  resolveModel,
  type AgentSettings,
  type HookEntry,
  type McpConfig,
} from './settingsSchema.js';
