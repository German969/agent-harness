# Infisical — self-hosted secrets manager

The dev-team router pulls per-session credentials from Infisical at session
prep time. This directory documents the self-hosted deploy option.

## Options

1. **Bundled with the main compose (recommended for solo VPS deploys)** — the
   top-level `docker-compose.yml` already includes an `infisical` service pointing
   at the same network. Add the Postgres + Redis containers by importing
   Infisical's official compose fragment (link below) into the same stack.

2. **Separate stack** — run Infisical in its own compose file / server; point
   `INFISICAL_SITE_URL` at that host.

## First-boot checklist

1. `cp .env.example .env` — generate every `CHANGE_ME` value:
   ```bash
   openssl rand -hex 32
   ```
2. Start Infisical (either bundled with main compose, or standalone).
3. Open `http://<host>:8082` (or your public URL) — create the initial admin.
4. Create a **project**: `dev-team-router`.
5. Create an **environment**: `dev`. The router reads this name from
   `INFISICAL_ENVIRONMENT` (see `deploy/.env.example`), and the deployed stack sets
   it to `dev` — there is one environment, not a dev/prod pair. A secret written to
   any other environment name resolves to nothing.
6. Create a **service token** with read access to `dev`. Copy the token → paste
   into `../.env` as `INFISICAL_TOKEN`. Copy the project ID → `INFISICAL_PROJECT_ID`.
7. Add per-agent secrets into the project.

   **`identities/<agent>.yml` → `secrets:` is authoritative.** Each identity file
   already declares the exact key name for every secret it needs, and
   `routing/secret-lookup.ts` resolves them by that name. Read the names off the
   file rather than deriving them — note the suffix is the agent id with
   **underscores** (`builder_server`, not `builder-server`).

   The common set, with `<agent>` being that underscored id:
   - `GITHUB_APP_PRIVATE_KEY_<agent>` — the App's `.pem`. The router mints
     short-lived installation tokens from it at session prep (`auth/github-app.ts`);
     do **not** store an installation token, which would be both wrong and expire.
   - `GITHUB_APP_WEBHOOK_SECRET_<agent>`
   - `LINEAR_TOKEN_<agent>`
   - `LINEAR_WEBHOOK_SECRET_<agent>`
   - `SLACK_BOT_TOKEN_<agent>`
   - `SLACK_SIGNING_SECRET_<agent>`
   - `ANTHROPIC_API_KEY` — **shared fleet-wide, not per-agent.** All seven
     identities reference this one unsuffixed key.
   - Agent-specific extras where declared (Marketer's `CMS_API_KEY_marketer`,
     `EMAIL_PLATFORM_API_KEY_marketer`, …), plus MCP-specific keys per
     `agents/<name>/mcp.json`.

   Generate any secret you control with the same command used elsewhere in this
   stack: `openssl rand -hex 32`.

   **Webhook secrets must match byte-for-byte** between the platform (GitHub App
   settings / Linear webhook config) and Infisical. A mismatch fails closed with a
   401 and the agent simply never fires — nothing surfaces near the agent itself,
   so it reads as a routing bug rather than a secret bug.

   A missing secret *reference* fails closed too: `secret-lookup.ts` returns
   `identity_missing_secret_ref: <role>` and the webhook route 404s
   `agent_not_configured`.

## References

- Infisical self-host docs: https://infisical.com/docs/self-hosting/overview
- Official docker-compose fragment: https://infisical.com/docs/self-hosting/deployment-options/docker-compose
