import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { transformTags } from '../scripts/_migrate/tags-to-relevance.mjs';

test('transformTags preserves existing structure + adds thresholds', () => {
  const input = {
    positive_default: ['教辅', '课程'],
    negative_default: ['鱼竿'],
    per_keyword: {
      小王者: { negative_extra: ['王者荣耀'] },
    },
  };
  const out = transformTags(input);
  assert.deepEqual(out.thresholds, { stage1: 0.55, stage2: 0.30, alpha: 0.4 });
  assert.deepEqual(out.positive_default, ['教辅', '课程']);
  assert.deepEqual(out.negative_default, ['鱼竿']);
  assert.deepEqual(out.per_keyword.小王者.negative_extra, ['王者荣耀']);
});

test('transformTags leaves existing thresholds alone', () => {
  const input = {
    thresholds: { stage1: 0.6, stage2: 0.4, alpha: 0.5 },
    positive_default: [],
    negative_default: [],
  };
  const out = transformTags(input);
  assert.deepEqual(out.thresholds, { stage1: 0.6, stage2: 0.4, alpha: 0.5 });
});

test('end-to-end: reads tags.yaml, writes relevance.yaml', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'qly-tags-'));
  try {
    const inputPath = path.join(tmp, 'tags.yaml');
    const outputPath = path.join(tmp, 'relevance.yaml');
    writeFileSync(inputPath, yaml.dump({
      positive_default: ['课程'],
      negative_default: ['鱼竿'],
      per_keyword: { 小王者: { negative_extra: ['王者荣耀'] } },
    }));
    const { runMigration } = await import('../scripts/_migrate/tags-to-relevance.mjs');
    runMigration(inputPath, outputPath);
    const out = yaml.load(readFileSync(outputPath, 'utf8'));
    assert.equal(out.thresholds.stage1, 0.55);
    assert.deepEqual(out.per_keyword.小王者.negative_extra, ['王者荣耀']);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
