import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config } from '../config.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(here, 'schema.sql');

/**
 * Open a database and apply the schema. `schema.sql` is written with
 * CREATE TABLE IF NOT EXISTS, so calling this against an existing file is a
 * no-op - safe to run on every boot.
 *
 * @param {string} path  file path, or ':memory:' for an ephemeral DB (tests)
 */
export function openDatabase(path = config.dbPath) {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);
  db.pragma('journal_mode = WAL');   // concurrent reads while the simulation writes
  db.pragma('foreign_keys = ON');    // not on by default in SQLite

  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

let singleton = null;

/** The process-wide database used by the running server. */
export function getDb() {
  if (!singleton) singleton = openDatabase();
  return singleton;
}

export function closeDb() {
  if (singleton) {
    singleton.close();
    singleton = null;
  }
}
