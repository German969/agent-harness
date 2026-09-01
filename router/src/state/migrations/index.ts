// Migration runner.
// Reads schema_version, applies pending forward-only migrations at startup.
// Each migration is one .sql file under this directory, numbered as NNN-name.sql.
// Once a migration is applied, never edit it — add a new file instead.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

const MIGRATIONS_DIR = dirname(fileURLToPath(import.meta.url));

type Migration = {
  version: number;
  name: string;
  sql: string;
};

export function loadMigrations(): Migration[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  return files.map((file) => {
    const match = file.match(/^(\d+)-(.+)\.sql$/);
    if (!match || !match[1] || !match[2]) {
      throw new Error(`Migration filename does not match NNN-name.sql pattern: ${file}`);
    }
    const version = Number.parseInt(match[1], 10);
    const name = match[2];
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
    return { version, name, sql };
  });
}

export function applyMigrations(db: Database.Database): { applied: number[]; skipped: number[] } {
  ensureSchemaVersionTable(db);
  const appliedSet = readAppliedVersions(db);
  const migrations = loadMigrations();

  const applied: number[] = [];
  const skipped: number[] = [];

  for (const m of migrations) {
    if (appliedSet.has(m.version)) {
      skipped.push(m.version);
      continue;
    }
    // Run the whole file as a transaction. If anything fails, the DB stays at the
    // prior version — no half-applied migrations.
    const txn = db.transaction(() => {
      db.exec(m.sql);
      // schema_version is created by 000-init.sql; safe to insert after exec.
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        m.version,
        Date.now(),
      );
    });
    txn();
    applied.push(m.version);
  }

  return { applied, skipped };
}

function ensureSchemaVersionTable(db: Database.Database): void {
  // Bootstrap: the schema_version table is created BY 000-init.sql. Before any
  // migration runs, it may not exist. We need to detect "fresh DB" vs "has
  // migrations" without depending on the table itself. Use sqlite_master.
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get();
  if (!row) {
    // Fresh DB. The 000-init.sql migration will create the table; nothing to do here.
    return;
  }
}

function readAppliedVersions(db: Database.Database): Set<number> {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get();
  if (!row) return new Set();
  const rows = db.prepare('SELECT version FROM schema_version').all() as { version: number }[];
  return new Set(rows.map((r) => r.version));
}
