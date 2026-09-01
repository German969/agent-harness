// SQLite connection + WAL mode + migration application.
// Single shared connection per router process; better-sqlite3 is synchronous so
// there's no async pool to manage.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { applyMigrations } from './migrations/index.js';

export type Db = Database.Database;

let instance: Db | undefined;

export type DbConfig = {
  /** Filesystem path; use ':memory:' for tests. */
  path: string;
  /** When true (default in production), set WAL mode + foreign_keys ON. */
  pragmas?: boolean;
};

export function openDb(cfg: DbConfig): Db {
  if (cfg.path !== ':memory:') {
    mkdirSync(dirname(cfg.path), { recursive: true });
  }

  const db = new Database(cfg.path);

  if (cfg.pragmas !== false) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
  }

  return db;
}

/**
 * Opens the DB at the given path, applies any pending migrations, returns the connection.
 * Idempotent — calling twice with the same path reuses the existing process-level instance.
 */
export function initDb(cfg: DbConfig): Db {
  if (instance) return instance;
  const db = openDb(cfg);
  applyMigrations(db);
  instance = db;
  return db;
}

/** Test-only: clear the process-level instance so the next initDb call opens fresh. */
export function resetDbForTests(): void {
  if (instance) {
    instance.close();
    instance = undefined;
  }
}

/** Returns the initialized DB; throws if initDb has not been called. */
export function getDb(): Db {
  if (!instance) throw new Error('DB not initialized. Call initDb() first.');
  return instance;
}
