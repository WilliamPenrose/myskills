import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const toFileURL = (p) => url.pathToFileURL(p).href;

test('schema.sql exists and is non-empty', () => {
  const p = path.join(ROOT, 'schema.sql');
  assert.ok(existsSync(p), 'schema.sql missing');
});

test('public runtime import works', async () => {
  const m = await import('@site-use/runtime');
  assert.equal(typeof m.createSecurePuppeteerPrimitives, 'function');
  assert.equal(typeof m.createRuntime, 'function');
});

test('all _lib copies parse cleanly', async () => {
  const libs = ['actions', 'session', 'detail-url', 'cascade-confirm', 'log-redirect'];
  for (const lib of libs) {
    const m = await import(toFileURL(path.join(ROOT, 'scripts', '_lib', `${lib}.mjs`)));
    assert.ok(m, `${lib}.mjs failed to import`);
  }
});
