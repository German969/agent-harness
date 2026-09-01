-- Re-key webhook_deliveries on (delivery_id, agent).
--
-- GitHub fans one repo event out to every installed App and reuses the SAME
-- X-GitHub-Delivery GUID for each copy. The ingress dedup keyed on delivery_id
-- alone therefore admitted only the first copy to arrive and answered the rest
-- with `{deduplicated:true}` before they ever reached the classifier.
--
-- That defeated the single-owner gate in routing/classifier.ts, which is built on
-- the opposite assumption: it expects every App's copy and dispatches the one whose
-- delivery matches the intended agent (`deliveredTo === target`). With only the
-- first-arriving copy surviving, an @-mention dispatched a session only when the
-- mentioned agent's App happened to deliver first — every other mention was dropped
-- as `github_duplicate_delivery` with no session spawned.
--
-- Keying on (delivery_id, agent) gives each App's copy its own idempotency row, so
-- all copies reach the classifier and the gate picks exactly one. Dedup still holds
-- per agent: a genuine GitHub redelivery of the same copy collides as before.
--
-- SQLite cannot ALTER a PRIMARY KEY, so this rebuilds the table. Existing rows carry
-- over unchanged (they already store `agent`), and the retention index is recreated
-- because DROP TABLE takes its indexes with it.
CREATE TABLE webhook_deliveries_new (
  delivery_id TEXT NOT NULL,
  provider    TEXT NOT NULL,
  agent       TEXT NOT NULL,  -- the agent whose App received THIS copy (deliveredTo)
  received_at INTEGER NOT NULL,
  event_type  TEXT NOT NULL,
  outcome     TEXT,
  PRIMARY KEY (delivery_id, agent)
);

INSERT INTO webhook_deliveries_new
  (delivery_id, provider, agent, received_at, event_type, outcome)
SELECT delivery_id, provider, agent, received_at, event_type, outcome
FROM webhook_deliveries;

DROP TABLE webhook_deliveries;

ALTER TABLE webhook_deliveries_new RENAME TO webhook_deliveries;

CREATE INDEX idx_webhook_deliveries_received ON webhook_deliveries(received_at);
