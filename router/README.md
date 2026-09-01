# Router

The custom router service for the dev-team agent fleet. Ingests webhooks from GitHub / Linear / Slack, classifies them to one of 7 agents, spawns Claude Agent SDK sessions, streams replies back, and persists state to SQLite.

For the **design**: read [ARCHITECTURE.md](ARCHITECTURE.md).
For the **build plan**: read [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).
For the **system context**: read [../PLAN.md](../PLAN.md).

## Dev setup

Requirements: Node 20.10+ and pnpm 10+.

```bash
cd router
pnpm install
pnpm dev          # starts on http://127.0.0.1:8080 with hot reload
```

Other scripts:

```bash
pnpm build        # TypeScript → dist/
pnpm start        # run the built artifact
pnpm test         # vitest (one-shot)
pnpm test:watch   # vitest in watch mode
pnpm lint         # biome check (read-only)
pnpm lint:fix     # biome check with auto-fix
pnpm format       # biome format with auto-fix
pnpm typecheck    # tsc --noEmit
```

## Smoke test

After `pnpm dev`:

```bash
curl http://127.0.0.1:8080/health
# → {"ok":true,"version":"0.1.0","uptimeMs":1234}

curl http://127.0.0.1:8080/ready
# → {"ready":true,"subsystems":{"db":"not_initialized",...}}
```

## Environment variables

Local dev reads from `.env` in this directory. Production reads from process env (injected via Infisical at session prep — see [ARCHITECTURE.md §2.10](ARCHITECTURE.md#210-secrets--infisical-client)).

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | Runtime mode (`development` / `production` / `test`) |
| `PORT` | `8080` | HTTP listen port |
| `HOST` | `127.0.0.1` | HTTP bind address (localhost-only by design; Cloudflare Tunnel publishes externally) |
| `LOG_LEVEL` | `info` | pino log level |

More env vars land as later phases ship (DB path in Phase 1, Infisical creds in Phase 2, etc.).

## Status

See [IMPLEMENTATION_PLAN.md → Overall status](IMPLEMENTATION_PLAN.md#overall-status) for the current phase.

## Stack — locked decisions

Per [ARCHITECTURE.md §0](ARCHITECTURE.md#tech-stack--locked-decisions):

- **Language**: TypeScript (ESM, NodeNext modules)
- **HTTP framework**: Fastify 5
- **State DB**: better-sqlite3 + WAL mode (Phase 1)
- **Secrets**: Infisical self-hosted (Phase 2)
- **Scheduler**: croner (Phase 9)
- **Logging**: pino
- **Errors**: Sentry (Phase 10)
- **Metrics**: prom-client (Phase 10)
- **Tests**: vitest
- **Lint + format**: biome
- **Claude calls**: `@anthropic-ai/claude-agent-sdk` (Phase 6)
