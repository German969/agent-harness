// Public surface of the state module.
// Other parts of the router import from here, not from individual files.

export { initDb, openDb, getDb, resetDbForTests, type Db, type DbConfig } from './db.js';
export { applyMigrations, loadMigrations } from './migrations/index.js';
export {
  createSession,
  getSession,
  updateStatus,
  addTurnCost,
  findContinuation,
  findRootSessionId,
  listRunning,
  markRunningAsInterrupted as markRunningAsInterruptedOnBoot,
  type SessionRow,
  type CreateSessionInput,
} from './sessions.js';
export {
  dayKey,
  recordTurnCost,
  recordSessionStart,
  getMonthlyAgentSpend,
  listMonthlyRollup,
  type DayKey,
  type DailyRollup,
} from './cost.js';
export {
  recordAlertEmitted,
  wasAlertEmitted,
  type AlertKey,
} from './cost_alerts.js';
export {
  tryRegisterDelivery,
  setOutcome as setWebhookOutcome,
  pruneOldDeliveries,
  type WebhookOutcome,
} from './webhooks.js';
export {
  recordRun as recordScheduleRun,
  lastRunForCron,
  hasActiveRunFor,
  getOverride,
  listOverrides,
  setOverride,
  clearOverride,
  listHistory as listScheduleOverrideHistory,
  type ScheduleOutcome,
  type ScheduleRunRow,
  type ScheduleOverrideRow,
  type ScheduleOverrideHistoryRow,
} from './schedule.js';
export {
  recordLink,
  chainDepth,
  chainPath,
  type AgentChainVia,
} from './agent_chain.js';
export { recordPrOwner, getPrOwner } from './pr_routing.js';
export {
  recordArtifactOrigin,
  findArtifactOrigin,
  type ArtifactOrigin,
} from './artifact_origin.js';
export {
  registerWorktree,
  findByTask as findWorktreeByTask,
  acquireLease,
  releaseLease,
  removeWorktree,
  listIdleWorktrees,
  listOldestIdle,
  type WorktreeRow,
} from './worktrees.js';
