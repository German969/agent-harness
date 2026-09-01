-- Migration 000 — initial schema.
-- Creates all 10 tables per router/ARCHITECTURE.md §2.6.
-- Forward-only. Never edit this file once committed; add a new migration instead.

-- ----------------------------------------------------------------------------
-- sessions: every router-managed Claude session, active or historical.
-- ----------------------------------------------------------------------------
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  skill TEXT,
  thread_key TEXT NOT NULL,
  claude_session_id TEXT,
  status TEXT NOT NULL,
  triggered_by TEXT NOT NULL,
  triggered_by_session_id INTEGER REFERENCES sessions(id),
  trigger_payload TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  turns INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  cost_input_tokens INTEGER NOT NULL DEFAULT 0,
  cost_output_tokens INTEGER NOT NULL DEFAULT 0,
  worktree_path TEXT,
  error_kind TEXT,
  notes TEXT
);
CREATE INDEX idx_sessions_thread ON sessions(thread_key, ended_at);
CREATE INDEX idx_sessions_agent_status ON sessions(agent, status);
CREATE INDEX idx_sessions_started ON sessions(started_at);

-- ----------------------------------------------------------------------------
-- cost_ledger: per-agent per-day rollup. The sessions table has per-session
-- truth; this table is for fast monthly-cap pre-flight checks.
-- ----------------------------------------------------------------------------
CREATE TABLE cost_ledger (
  agent TEXT NOT NULL,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  day INTEGER NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  sessions_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent, year, month, day)
);
CREATE INDEX idx_cost_ledger_month ON cost_ledger(agent, year, month);

-- ----------------------------------------------------------------------------
-- webhook_deliveries: idempotency dedup. Retention 30 days (older rows pruned).
-- ----------------------------------------------------------------------------
CREATE TABLE webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  agent TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  outcome TEXT
);
CREATE INDEX idx_webhook_deliveries_received ON webhook_deliveries(received_at);

-- ----------------------------------------------------------------------------
-- pending_sessions: queue for sessions waiting on a busy worktree.
-- ----------------------------------------------------------------------------
CREATE TABLE pending_sessions (
  id INTEGER PRIMARY KEY,
  thread_key TEXT NOT NULL,
  classification TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL
);

-- ----------------------------------------------------------------------------
-- schedule_runs: history of every cron tick (started / skipped / failed).
-- ----------------------------------------------------------------------------
CREATE TABLE schedule_runs (
  id INTEGER PRIMARY KEY,
  cron_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  fired_at INTEGER NOT NULL,
  session_id INTEGER REFERENCES sessions(id),
  outcome TEXT
);

-- ----------------------------------------------------------------------------
-- schedule_overrides: runtime enable/disable per cron_id.
-- Effective enabled = override.enabled if row exists, else yaml.enabled.
-- ----------------------------------------------------------------------------
CREATE TABLE schedule_overrides (
  cron_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL,
  set_by TEXT NOT NULL,
  set_at INTEGER NOT NULL,
  reason TEXT
);

-- ----------------------------------------------------------------------------
-- schedule_override_history: append-only audit trail of toggles.
-- ----------------------------------------------------------------------------
CREATE TABLE schedule_override_history (
  id INTEGER PRIMARY KEY,
  cron_id TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  set_by TEXT NOT NULL,
  set_at INTEGER NOT NULL,
  reason TEXT
);
CREATE INDEX idx_schedule_override_history_cron ON schedule_override_history(cron_id, set_at);

-- ----------------------------------------------------------------------------
-- agent_chain: parent→child session links (loop prevention; depth >5 alerts).
-- ----------------------------------------------------------------------------
CREATE TABLE agent_chain (
  id INTEGER PRIMARY KEY,
  parent_session_id INTEGER REFERENCES sessions(id),
  child_session_id INTEGER REFERENCES sessions(id),
  via TEXT NOT NULL
);
CREATE INDEX idx_agent_chain_parent ON agent_chain(parent_session_id);

-- ----------------------------------------------------------------------------
-- worktrees: per-task git worktree leases + LRU prune tracking.
-- ----------------------------------------------------------------------------
CREATE TABLE worktrees (
  path TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  task_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  active_session_id INTEGER REFERENCES sessions(id)
);

-- ----------------------------------------------------------------------------
-- schema_version: applied-migrations registry. Inserted by the migration runner.
-- ----------------------------------------------------------------------------
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
