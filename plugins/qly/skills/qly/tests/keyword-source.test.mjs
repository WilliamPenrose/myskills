import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { loadKeywords } from '../scripts/_lib/keyword-source.mjs';

test('csv: returns only is_track=1 rows', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'qly-kw-'));
  try {
    const p = path.join(tmp, 'kw.csv');
    writeFileSync(p, [
      'id,key_word,is_track,info_pp',
      'A1,foo,1,xes',
      'A2,bar,0,xes',
      'A3,baz,1,xwx',
    ].join('\n'));
    const kws = await loadKeywords(p);
    assert.deepEqual(kws.map(k => k.key_word), ['foo', 'baz']);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('csv: throws when required columns missing', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'qly-kw-'));
  try {
    const p = path.join(tmp, 'kw.csv');
    writeFileSync(p, 'foo,bar\n1,2\n');
    await assert.rejects(loadKeywords(p), /key_word|is_track/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('xlsx: parses + filters is_track=1', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'qly-kw-'));
  try {
    const p = path.join(tmp, 'kw.xlsx');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('s');
    ws.addRow(['id', 'key_word', 'is_track']);
    ws.addRow(['A1', 'foo', 1]);
    ws.addRow(['A2', 'bar', 0]);
    await wb.xlsx.writeFile(p);
    const kws = await loadKeywords(p);
    assert.deepEqual(kws.map(k => k.key_word), ['foo']);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
