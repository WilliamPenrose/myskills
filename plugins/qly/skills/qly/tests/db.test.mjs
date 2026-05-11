import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../scripts/_lib/db.mjs';

test('openDb creates db + applies schema on fresh dir', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'qly-db-'));
  try {
    const dbPath = path.join(tmp, 'qlydata.db');
    const db = openDb(dbPath);
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
      assert.deepEqual(tables, ['influencer_pid_runs', 'influencer_sightings', 'relevance_annotations', 'sightings']);
      assert.ok(existsSync(dbPath));
    } finally {
      db.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('openDb is idempotent on existing db', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'qly-db-'));
  try {
    const dbPath = path.join(tmp, 'qlydata.db');
    openDb(dbPath).close();
    openDb(dbPath).close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
