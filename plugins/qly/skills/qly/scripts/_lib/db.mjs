import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, '../../schema.sql');

let cachedSchema = null;
function loadSchema() {
  if (cachedSchema === null) cachedSchema = readFileSync(SCHEMA_PATH, 'utf8');
  return cachedSchema;
}

/**
 * Open the qly SQLite db at the given path, applying schema.sql
 * (idempotent via CREATE TABLE IF NOT EXISTS). Creates parent dirs.
 */
export function openDb(dbPath) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(loadSchema());
  return db;
}
