import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, loadRelevance, tagsFor } from '../scripts/_lib/config.mjs';

test('tagsFor merges defaults with negative_extra', () => {
  const cfg = {
    positive_default: ['p1', 'p2'],
    negative_default: ['n1'],
    per_keyword: { '小王者': { negative_extra: ['王者荣耀'] } },
  };
  const { positives, negatives } = tagsFor(cfg, '小王者');
  assert.deepEqual(positives, ['p1', 'p2']);
  assert.deepEqual(negatives, ['n1', '王者荣耀']);
});

test('tagsFor positive/negative override replaces defaults', () => {
  const cfg = {
    positive_default: ['p1'],
    negative_default: ['n1'],
    per_keyword: { '猴子': { negative: ['nx'] } },
  };
  const { positives, negatives } = tagsFor(cfg, '猴子');
  assert.deepEqual(positives, ['p1']);
  assert.deepEqual(negatives, ['nx']);
});

test('tagsFor returns defaults for unknown keyword', () => {
  const cfg = { positive_default: ['p1'], negative_default: ['n1'] };
  const { positives, negatives } = tagsFor(cfg, '未知');
  assert.deepEqual(positives, ['p1']);
  assert.deepEqual(negatives, ['n1']);
});

test('tagsFor deduplicates', () => {
  const cfg = {
    positive_default: ['a', 'b'],
    per_keyword: { kw: { positive_extra: ['a', 'c'] } },
  };
  const { positives } = tagsFor(cfg, 'kw');
  assert.deepEqual(positives, ['a', 'b', 'c']);
});

test('loadConfig reads yaml + validates required path', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'qly-config-'));
  try {
    const p = path.join(tmp, 'config.yaml');
    writeFileSync(p, [
      'filters:',
      '  price: [5, 500]',
      '  live_sales: [1, 100000]',
      'influencer:',
      '  min_gmv: 1',
      '  window_days: 7',
      'keywords_source:',
      '  path: D:/sample.csv',
    ].join('\n'));
    const cfg = loadConfig(p);
    assert.equal(cfg.keywords_source.path, 'D:/sample.csv');
    assert.equal(cfg.filters.price[1], 500);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadConfig throws on missing keywords_source.path', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'qly-config-'));
  try {
    const p = path.join(tmp, 'config.yaml');
    writeFileSync(p, 'filters:\n  price: [5, 500]\n');
    assert.throws(() => loadConfig(p), /keywords_source\.path/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
