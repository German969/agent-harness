// Per-session jsonl deep trace.
//
// Every session gets a single file at `<logDir>/<sessionId>.jsonl`. Lines are
// appended synchronously via appendFileSync — small volume, no need for a
// stream, and synchronous means we never lose lines on crash.
//
// The `dev-team-logs session <id> --tail` CLI reads these files directly.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type SessionLogEntry = {
  ts: string; // ISO timestamp
  event: string; // e.g. 'session.started', 'turn.complete', 'hook.gate', 'mcp.spawned'
  level?: 'info' | 'warn' | 'error';
  data?: Record<string, unknown>;
};

export type SessionLogWriter = {
  /** Write one jsonl line to this session's log file. */
  write(entry: SessionLogEntry): void;
  /** The full path to the log file (for CLI + debugging). */
  path: string;
  /** Session id — for logging fan-out. */
  sessionId: number;
};

export type SessionLogOptions = {
  logDir: string;
  sessionId: number;
};

/**
 * Build a writer scoped to one session. First write creates the file (via
 * append); subsequent writes append. Idempotent mkdir on the log dir.
 */
export function openSessionLog(opts: SessionLogOptions): SessionLogWriter {
  mkdirSync(opts.logDir, { recursive: true });
  const path = join(opts.logDir, `${opts.sessionId}.jsonl`);
  return {
    path,
    sessionId: opts.sessionId,
    write(entry: SessionLogEntry): void {
      const line: SessionLogEntry & { ts: string } = {
        ts: entry.ts || new Date().toISOString(),
        event: entry.event,
        ...(entry.level ? { level: entry.level } : {}),
        ...(entry.data ? { data: entry.data } : {}),
      };
      appendFileSync(path, `${JSON.stringify(line)}\n`, 'utf-8');
    },
  };
}

/**
 * Build a no-op writer. Used when the router is configured without session
 * logging (e.g. `SESSION_LOG_DIR=""`). Callers keep the same interface.
 */
export function noopSessionLog(sessionId: number): SessionLogWriter {
  return {
    path: '',
    sessionId,
    write(): void {
      /* discard */
    },
  };
}
