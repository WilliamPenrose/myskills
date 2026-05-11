import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { decideConclusion, gateDecision } from '../scripts/_lib/influencer-helpers.mjs';

test('any dropped -> 不抓-人工 dropped', () => {
  assert.equal(decideConclusion({ nKept: 1, nDropped: 1, gmv7d: 999, minGmv: 1 }), '不抓-人工 dropped');
  assert.equal(decideConclusion({ nKept: 0, nDropped: 2, gmv7d: 0, minGmv: 1 }), '不抓-人工 dropped');
});

test('kept exists + gmv below min -> 不抓-销售额过低', () => {
  assert.equal(decideConclusion({ nKept: 1, nDropped: 0, gmv7d: 0, minGmv: 1 }), '不抓-销售额过低');
  assert.equal(decideConclusion({ nKept: 1, nDropped: 0, gmv7d: NaN, minGmv: 1 }), '不抓-销售额过低');
});

test('kept exists + gmv >= min -> 抓', () => {
  assert.equal(decideConclusion({ nKept: 1, nDropped: 0, gmv7d: 1, minGmv: 1 }), '抓');
  assert.equal(decideConclusion({ nKept: 3, nDropped: 0, gmv7d: 1e6, minGmv: 1 }), '抓');
});

test('no annotations -> 不抓-未标注', () => {
  assert.equal(decideConclusion({ nKept: 0, nDropped: 0, gmv7d: 100, minGmv: 1 }), '不抓-未标注');
});

function mkDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE influencer_pid_runs (
      pid TEXT NOT NULL, filter TEXT NOT NULL, scraped_at TEXT NOT NULL,
      uid_count INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT,
      PRIMARY KEY (pid, filter, scraped_at)
    );
  `);
  return db;
}

test('gate: never-run pid -> eligible', () => {
  const db = mkDb();
  const d = gateDecision(db, 'p1', 'live', { windowDays: 7, retryAfterMs: null, force: false });
  assert.equal(d.skip, false);
});

test('gate: recent success skips within window', () => {
  const db = mkDb();
  const recent = new Date(Date.now() - 86400 * 1000).toISOString();
  db.prepare("INSERT INTO influencer_pid_runs VALUES ('p1', 'live', ?, 10, 'ok', null)").run(recent);
  const d = gateDecision(db, 'p1', 'live', { windowDays: 7, retryAfterMs: null, force: false });
  assert.equal(d.skip, true);
});

test('gate: ancient success allows re-run', () => {
  const db = mkDb();
  const old = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
  db.prepare("INSERT INTO influencer_pid_runs VALUES ('p1', 'live', ?, 10, 'ok', null)").run(old);
  const d = gateDecision(db, 'p1', 'live', { windowDays: 7, retryAfterMs: null, force: false });
  assert.equal(d.skip, false);
});

test('gate: failed pid skipped without --retry', () => {
  const db = mkDb();
  const recent = new Date(Date.now() - 86400 * 1000).toISOString();
  db.prepare("INSERT INTO influencer_pid_runs VALUES ('p1', 'live', ?, 0, 'failed', 'timeout')").run(recent);
  const d = gateDecision(db, 'p1', 'live', { windowDays: 7, retryAfterMs: null, force: false });
  assert.equal(d.skip, true);
  assert.match(d.reason, /prior failure/);
});

test('gate: --force overrides everything', () => {
  const db = mkDb();
  const recent = new Date(Date.now() - 86400 * 1000).toISOString();
  db.prepare("INSERT INTO influencer_pid_runs VALUES ('p1', 'live', ?, 10, 'ok', null)").run(recent);
  const d = gateDecision(db, 'p1', 'live', { windowDays: 7, retryAfterMs: null, force: true });
  assert.equal(d.skip, false);
});
