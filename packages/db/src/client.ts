import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.ts';

export type Db = ReturnType<typeof openDb>;

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');

/** Open (and migrate) a database. Pass ":memory:" in tests. */
export function openDb(path: string, opts: { migrationsFolder?: string } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: opts.migrationsFolder ?? process.env.MIGRATIONS_DIR ?? migrationsFolder });
  return db;
}
