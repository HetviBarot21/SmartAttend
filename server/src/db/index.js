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
  migrate(db);
  return db;
}

/**
 * Column additions to tables that already existed before this column was
 * introduced. `CREATE TABLE IF NOT EXISTS` (above) is a no-op against an
 * existing table, so a new column needs an explicit, idempotent ALTER here -
 * this runs on every boot and is a no-op once the column is present.
 */
function migrate(db) {
  const hasColumn = (table, column) =>
    db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, column) != null;

  if (!hasColumn('class_groups', 'teacher_name')) {
    db.exec(`ALTER TABLE class_groups ADD COLUMN teacher_name TEXT`);
  }
  if (!hasColumn('students', 'guardian_phone')) {
    db.exec(`ALTER TABLE students ADD COLUMN guardian_phone TEXT`);
  }
  if (!hasColumn('students', 'guardian_email')) {
    db.exec(`ALTER TABLE students ADD COLUMN guardian_email TEXT`);
  }
  if (!hasColumn('schools', 'status')) {
    db.exec(`ALTER TABLE schools ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'))`);
  }
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
