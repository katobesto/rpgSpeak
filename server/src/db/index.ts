import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export type Db = ReturnType<typeof drizzle<typeof schema>>;

let _db: Db | null = null;

export function initDb(dbPath: string): Db {
  const sqlite = new Database(dbPath);

  // WAL mode for better concurrent read performance
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('cache_size = -32000'); // 32MB cache

  _db = drizzle(sqlite, { schema });
  return _db;
}

export function getDb(): Db {
  if (!_db) throw new Error('Database not initialized. Call initDb() first.');
  return _db;
}
