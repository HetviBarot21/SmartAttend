// CLI: create the database file and apply the schema.
//   node src/db/init.js            - create if missing, otherwise leave as-is
//   node src/db/init.js --reset    - delete the file first, then recreate
import { existsSync, rmSync } from 'node:fs';
import { openDatabase } from './index.js';
import { config } from '../config.js';

const reset = process.argv.includes('--reset');

if (reset && config.dbPath !== ':memory:' && existsSync(config.dbPath)) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(config.dbPath + suffix, { force: true });
  console.log(`Removed existing database at ${config.dbPath}`);
}

const db = openDatabase();
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name);

console.log(`Database ready at ${config.dbPath}`);
console.log(`Tables (${tables.length}): ${tables.join(', ')}`);
db.close();
