# dev-team router — multi-stage build.
#
# Stage 1 (deps): install pnpm + prod-only deps. Cached as long as
#                 pnpm-lock.yaml + package.json are unchanged.
# Stage 2 (build): compile TypeScript → dist/. Includes devDeps.
# Stage 3 (runtime): minimal — Node + prod deps + dist/. Non-root user.
#
# Build from the dev-team repo root:
#   docker build -f deploy/Dockerfile -t dev-team-router:latest .

# ============================================================================
# 1) deps — cached layer for prod dependencies
# ============================================================================
FROM node:20.10.0-bookworm-slim AS deps

# Build tools needed to compile better-sqlite3's native binding against the
# container's arch. Removed from the final image via multi-stage.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

WORKDIR /app

# Copy only the manifest + lockfile — Docker will cache this layer as long as
# they're unchanged.
COPY router/package.json router/pnpm-lock.yaml* ./

# Install prod-only deps. We DO run install scripts here — better-sqlite3's
# postinstall compiles the native .node binding, without which the router
# crashes at DB open. pnpm.onlyBuiltDependencies in package.json restricts
# which packages are allowed to run scripts (better-sqlite3 + esbuild + biome).
RUN pnpm install --frozen-lockfile --prod

# ============================================================================
# 2) build — compile TypeScript
# ============================================================================
FROM node:20.10.0-bookworm-slim AS build

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

WORKDIR /app

COPY router/package.json router/pnpm-lock.yaml* router/tsconfig.json router/biome.json ./
COPY router/scripts ./scripts

# Include devDeps for tsc + copy-assets. --ignore-scripts is fine here — the
# build stage only compiles TypeScript; native bindings live in the deps stage.
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY router/src ./src

RUN pnpm build

# ============================================================================
# 3) runtime — minimal image
# ============================================================================
FROM node:20.10.0-bookworm-slim AS runtime

# Runtime deps: git (for worktrees), openssh-client (git push over SSH for the
# dev-team-state `push: true` hooks — GIT_SSH_COMMAND needs a real `ssh` binary),
# sqlite3 (CLI for backups), tini (PID 1), ca-certificates (for outbound HTTPS).
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      openssh-client \
      sqlite3 \
      tini \
      ca-certificates \
      curl \
    && rm -rf /var/lib/apt/lists/*

# Bake the stdio MCP servers into the image. Sessions previously `npx -y`'d these at
# spawn time, which installs the package on first use — fragile: a corrupted npx cache
# under VPS disk pressure SIGKILLed the whole tool surface mid-session. Installing them
# globally at build time makes spawning deterministic and offline (no per-session
# download). Pinned to exact versions — these are archived reference servers, so the
# pins are effectively final. Each agent's mcp.json invokes them by absolute path
# (/usr/local/bin/mcp-server-*). The `@anthropic-ai/mcp-claude-preview` server stays on
# npx by design: it's an evolving preview package that a version pin would freeze.
RUN npm install -g \
      @modelcontextprotocol/server-github@2025.4.8 \
      @modelcontextprotocol/server-slack@2025.4.25 \
      @modelcontextprotocol/server-filesystem@2026.7.10 \
    && npm cache clean --force

# Non-root user.
RUN groupadd -g 1001 agents && \
    useradd -u 1001 -g agents -m -s /bin/bash agents && \
    mkdir -p /var/lib/agents /var/log/agents/sessions && \
    chown -R agents:agents /var/lib/agents /var/log/agents

WORKDIR /app

COPY --from=deps  --chown=agents:agents /app/node_modules ./node_modules
COPY --from=build --chown=agents:agents /app/dist ./dist
COPY --chown=agents:agents router/package.json ./

USER agents

# Bind mounts from the host (/opt/dev-team, /opt/dev-team-state) are owned by a
# different UID than the container's `agents` (1001). Git's "dubious ownership"
# check refuses to operate on repos it doesn't own, blocking every SessionEnd
# `git_commit_if_changed` hook. Trust all mounted repos globally — bind mounts
# in this container are always the router's own state, never external code.
RUN git config --global --add safe.directory '*'

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    LOG_LEVEL=info \
    STATE_DB_PATH=/var/lib/agents/state.sqlite \
    DEV_TEAM_ROOT=/var/lib/agents/dev-team \
    SESSION_LOG_DIR=/var/log/agents/sessions

EXPOSE 8080

# tini forwards signals correctly + reaps zombies (MCP children).
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
