-- Phase 8 — cost-cap warning idempotency.
--
-- One row per (agent, year, month, level). Ensures a warning post fires at most
-- once per threshold per agent per month, even across router restarts.
-- `level` is the integer percentage threshold that was crossed (e.g. 80, 100).

CREATE TABLE cost_alerts_emitted (
  agent TEXT NOT NULL,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  level INTEGER NOT NULL,
  emitted_at INTEGER NOT NULL,
  cost_usd_at_emit REAL NOT NULL,
  PRIMARY KEY (agent, year, month, level)
);
