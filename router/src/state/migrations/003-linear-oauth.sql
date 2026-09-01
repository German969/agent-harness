-- Linear actor=app OAuth token store (auto-refresh).
--
-- Linear's actor=app access tokens expire every 24h and must be renewed using the
-- rotating refresh_token (each refresh returns a NEW refresh_token, with a 30-min
-- replay grace). The router mints fresh access tokens on demand and persists the
-- rotated refresh token here so it survives restarts and is shared across sessions.
-- Single logical row (id = 1) since all agents share one OAuth app token.

CREATE TABLE linear_oauth (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,   -- ms epoch when the access token expires
  updated_at    INTEGER NOT NULL
);
