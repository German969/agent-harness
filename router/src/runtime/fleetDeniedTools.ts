// Tools no agent in this fleet may use, denied in the router rather than in each
// agent's settings.json.
//
// Why the router and not config: `permissions.deny` is the only permission field
// that actually restricts anything. `permissions.allow` is a prompt-skip list —
// the SDK's own docs say "to restrict which tools are available, use the `tools`
// option instead" — the router never sets `tools`, and its canUseTool allows
// whatever no PreToolUse hook denies. So every built-in the CLI ships is available
// to every agent unless it is denied, INCLUDING tools no agent's config mentions.
//
// Seven copies of this list would drift the first time an agent was edited, and a
// newly onboarded agent would start with none of it. One list, applied to every
// session, cannot.
//
// What is on it and why — each of these starts work outside the router's model:
//
//   - Agent: spawns subagents. A subagent is not a session, so it is invisible to
//     the `sessions` table, to `agent_chain`, and to MAX_CHAIN_DEPTH — the loop
//     guard we hardened twice does not see it at all.
//   - Workflow: multi-agent orchestration, same blind spot at much larger scale.
//   - Task*: background tasks that outlive the turn that made them.
//   - Cron*, ScheduleWakeup, RemoteTrigger: scheduling. Recurring work is
//     scheduler/schedules.yml, which is reviewed, default-off and phase-gated. An
//     agent scheduling itself answers to none of that.
//   - EnterWorktree / ExitWorktree: checkouts are leased by the workspace manager,
//     which owns the lease rows the pruner reads. A worktree made outside that is
//     unowned and never reclaimed.
//   - PushNotification: outbound messaging that bypasses the reply layer.
//
// Cost is not the reason — subagent tokens roll up into the parent's usage, so the
// per-job cap still counts them. Visibility and the loop guard are.
//
// Denying a tool the current host does not expose is a rule that never matches, so
// listing the full family is free and survives a host that adds one back.
export const FLEET_DENIED_TOOLS: readonly string[] = [
  'Agent',
  'Workflow',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'RemoteTrigger',
  'EnterWorktree',
  'ExitWorktree',
  'PushNotification',
];

/**
 * The effective deny list for a session: the fleet-wide set plus the agent's own.
 * De-duplicated so an agent that also lists one of these does not double it.
 */
export function effectiveDeniedTools(agentDeny: readonly string[]): string[] {
  return [...new Set([...FLEET_DENIED_TOOLS, ...agentDeny])];
}
