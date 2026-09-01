-- artifact_origin: which session created a work artifact, so a chain can be
-- followed ACROSS threads.
--
-- agent_chain links a parent to a child, and the parent is found via
-- findContinuation — which matches on thread_key. That only ever finds a hop
-- inside ONE thread. When an agent creates a Linear ticket and a different agent
-- picks it up, the new ticket is a new thread: no continuation, no parent, and the
-- depth counter starts again at zero. A fan-out built entirely from
-- agent-created tickets is therefore unbounded, and it is the shape decomposition
-- makes easy to reach — one agent splitting work into three tickets, each of
-- which can split again.
--
-- Recording the creating session at creation time closes it: the first session on
-- a ticket an agent made is linked back to the session that made it, so depth
-- survives the thread boundary.
--
-- Keyed by thread_key rather than by a Linear id so the lookup at classify time is
-- a direct hit on the value the classifier already computed, with no per-provider
-- parsing on the read path.
CREATE TABLE artifact_origin (
  thread_key TEXT PRIMARY KEY,          -- e.g. "linear:IRS-47" — the key events on it will carry
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  created_at INTEGER NOT NULL           -- ms epoch
);
CREATE INDEX idx_artifact_origin_session ON artifact_origin(session_id);
