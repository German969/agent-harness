-- Cache-token traceability (followup #15).
--
-- Anthropic bills three input categories separately: `input_tokens` (uncached),
-- `cache_creation_input_tokens` (~25% markup over input), `cache_read_input_tokens`
-- (~10% of input). Adapter's cost estimator was updated in commit 8cd2741 to
-- read all three, but the persisted rows (`sessions.cost_*_tokens`,
-- `cost_ledger.*_tokens`) only carried input + output. That leaves the DB
-- unable to answer "why did this session cost so much?" via SQL — the cost is
-- correct but the token breakdown doesn't add up.
--
-- Add cache_write + cache_read columns to both tables so per-session /
-- per-daily rollups tell the full story.

ALTER TABLE sessions ADD COLUMN cost_cache_write_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN cost_cache_read_tokens INTEGER NOT NULL DEFAULT 0;

ALTER TABLE cost_ledger ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cost_ledger ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
