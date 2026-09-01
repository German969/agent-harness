-- PR ownership map for owner-per-PR GitHub routing.
--
-- Every installed GitHub App receives its own delivery of each PR event, so the
-- classifier gates PR-scoped events to a single owner agent (an `agent:<name>`
-- label, else the app that opened the PR). PR events carry the labels + author
-- needed to resolve that owner; CI events (check_suite / check_run / workflow_run)
-- do NOT — their payloads reference the PR only by number. This table caches the
-- resolved owner (written whenever a pull_request*/PR-comment event resolves one)
-- so those CI events can be gated to the same owner instead of cascading to every
-- installed app.
CREATE TABLE pr_owner (
  repo       TEXT NOT NULL,     -- repository full name, e.g. "german969/chatbots"
  number     INTEGER NOT NULL,  -- PR number
  agent      TEXT NOT NULL,     -- resolved owner agent id
  updated_at INTEGER NOT NULL,  -- ms epoch of last refresh
  PRIMARY KEY (repo, number)
);
