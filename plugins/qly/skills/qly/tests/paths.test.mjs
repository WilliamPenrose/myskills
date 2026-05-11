import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveDataDir } from '../scripts/_lib/paths.mjs';

test('--data-dir flag wins', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'qly-paths-'));
  try {
    const result = resolveDataDir({ cliFlag: tmp, env: {}, cwd: '/somewhere/else' });
    assert.equal(result, path.resolve(tmp));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('QLY_DATA_DIR env beats cwd search', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'qly-paths-'));
  try {
    const result = resolveDataDir({ cliFlag: undefined, env: { QLY_DATA_DIR: tmp }, cwd: '/somewhere/else' });
    assert.equal(result, path.resolve(tmp));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('walks up to find nearest existing .qlydata/', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'qly-paths-'));
  try {
    const cwd = path.join(root, 'a', 'b', 'c');
    mkdirSync(cwd, { recursive: true });
    const dataDir = path.join(root, 'a', '.qlydata');
    mkdirSync(dataDir);
    const result = resolveDataDir({ cliFlag: undefined, env: {}, cwd });
    assert.equal(result, dataDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('falls back to <cwd>/.qlydata/ when nothing found', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'qly-paths-'));
  try {
    const result = resolveDataDir({ cliFlag: undefined, env: {}, cwd: tmp });
    assert.equal(result, path.join(tmp, '.qlydata'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
