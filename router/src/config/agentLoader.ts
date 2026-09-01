// Agent config loader with mtime-based cache invalidation.
//
// Loads for each agent:
//   - CLAUDE.md          (raw markdown; the system prompt)
//   - settings.json      (parsed + zod-validated)
//   - mcp.json           (parsed + zod-validated)
//   - skills/*.md        (raw markdown; keyed by base filename)
//
// Cache policy: on every load call, stat all files. If any mtime > cached
// mtime OR any file appeared/disappeared, reload. This is a lightweight
// alternative to a filesystem watcher and matches the "hot-reload on git pull"
// design in router/ARCHITECTURE.md §2.13.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentId } from '../types.js';
import {
  type AgentSettings,
  AgentSettingsSchema,
  type McpConfig,
  McpConfigSchema,
} from './settingsSchema.js';

export type AgentConfig = {
  agent: AgentId;
  claudeMd: string;
  settings: AgentSettings;
  mcp: McpConfig;
  skills: Map<string, string>; // filename-without-.md → content
};

type CacheEntry = {
  config: AgentConfig;
  fingerprint: string; // aggregated mtime signature
};

const cache = new Map<AgentId, CacheEntry>();

export type LoadOptions = {
  /** Root directory containing `agents/<name>/`. Usually dev-team repo root. */
  devTeamRoot: string;
};

export class AgentConfigError extends Error {
  override readonly name = 'AgentConfigError';
  constructor(
    public readonly agent: AgentId,
    public readonly file: string,
    public readonly reason: string,
  ) {
    super(`agent config error [${agent}] ${file}: ${reason}`);
  }
}

/**
 * Load an agent's full config bundle. Returns the cached result if unchanged
 * since last load; otherwise reads fresh from disk + revalidates.
 */
export function loadAgentConfig(agent: AgentId, opts: LoadOptions): AgentConfig {
  const dir = join(opts.devTeamRoot, 'agents', agent);
  const paths = {
    claudeMd: join(dir, 'CLAUDE.md'),
    settings: join(dir, 'settings.json'),
    mcp: join(dir, 'mcp.json'),
    skillsDir: join(dir, 'skills'),
  };

  const fingerprint = fingerprintOf(paths);
  const cached = cache.get(agent);
  if (cached && cached.fingerprint === fingerprint) return cached.config;

  const claudeMd = readOrThrow(agent, paths.claudeMd, 'CLAUDE.md');
  const settingsRaw = readJsonOrThrow(agent, paths.settings, 'settings.json');
  const settings = validateOrThrow(agent, 'settings.json', () =>
    AgentSettingsSchema.parse(settingsRaw),
  );
  const mcpRaw = readJsonOrThrow(agent, paths.mcp, 'mcp.json');
  const mcp = validateOrThrow(agent, 'mcp.json', () => McpConfigSchema.parse(mcpRaw));
  const skills = loadSkills(agent, paths.skillsDir);

  const config: AgentConfig = { agent, claudeMd, settings, mcp, skills };
  cache.set(agent, { config, fingerprint });
  return config;
}

/** Clear the entire cache. Used by tests + on-demand hot-reload signals. */
export function clearAgentConfigCache(): void {
  cache.clear();
}

/** Number of cached agents; test-only helper. */
export function agentConfigCacheSize(): number {
  return cache.size;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function fingerprintOf(paths: {
  claudeMd: string;
  settings: string;
  mcp: string;
  skillsDir: string;
}): string {
  const parts: string[] = [];
  for (const p of [paths.claudeMd, paths.settings, paths.mcp]) {
    parts.push(`${p}:${safeMtime(p)}`);
  }
  // Include every skill file's mtime — added/removed files change the fingerprint too.
  try {
    const files = readdirSync(paths.skillsDir).sort();
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      const full = join(paths.skillsDir, f);
      parts.push(`${full}:${safeMtime(full)}`);
    }
  } catch {
    parts.push(`${paths.skillsDir}:missing`);
  }
  return parts.join('|');
}

function safeMtime(path: string): number | 'missing' {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 'missing';
  }
}

function readOrThrow(agent: AgentId, path: string, label: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    throw new AgentConfigError(agent, label, `read failed: ${(err as Error).message}`);
  }
}

function readJsonOrThrow(agent: AgentId, path: string, label: string): unknown {
  const raw = readOrThrow(agent, path, label);
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new AgentConfigError(agent, label, `invalid JSON: ${(err as Error).message}`);
  }
}

function validateOrThrow<T>(agent: AgentId, label: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new AgentConfigError(agent, label, `schema validation failed: ${(err as Error).message}`);
  }
}

function loadSkills(agent: AgentId, skillsDir: string): Map<string, string> {
  const out = new Map<string, string>();
  let files: string[];
  try {
    files = readdirSync(skillsDir);
  } catch {
    // No skills/ dir is OK — some agents may have none.
    return out;
  }
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    const name = f.slice(0, -3);
    try {
      const content = readFileSync(join(skillsDir, f), 'utf-8');
      out.set(name, content);
    } catch (err) {
      throw new AgentConfigError(agent, `skills/${f}`, `read failed: ${(err as Error).message}`);
    }
  }
  return out;
}
