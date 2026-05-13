// relevance.mjs — score + export + import + audit subcommands.
//
// Usage:
//   node relevance.mjs score [--keyword <k>] [--out <json>]
//   node relevance.mjs export [--filter pending|low_signal_kept|low_signal_review|borderline|dropped|all] [--days N] [--out <xlsx>]
//   node relevance.mjs import --in <xlsx> [--dry-run] [--no-archive]
//   node relevance.mjs audit

import process from 'node:process';
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

import ExcelJS from 'exceljs';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { pipeline, env as xenoEnv } from '@xenova/transformers';

import { resolveDataDir, dataDirPaths } from './_lib/paths.mjs';
import { openDb } from './_lib/db.mjs';
import { loadRelevance, tagsFor } from './_lib/config.mjs';

const MODEL_ID = 'Xenova/bge-base-zh-v1.5';

function setupProxy() {
  const proxyUrl = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  if (proxyUrl) setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

function setupTransformersCache(dataDir) {
  xenoEnv.cacheDir = path.join(dataDir, '.cache', 'transformers');
  xenoEnv.allowLocalModels = true;
  xenoEnv.remoteHost = process.env.HF_HOST ?? 'https://hf-mirror.com';
}

function buildQueries(keyword, positives, negatives) {
  return {
    v2: positives.length
      ? `类目: ${positives[0] ?? ''}. 主题: ${positives.slice(1).join(' ') || positives[0] || ''}. 关键词: ${keyword}`
      : `关键词: ${keyword}`,
    neg: negatives.length ? negatives.join(' ') : null,
  };
}

function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

async function embedAll(extractor, texts, label) {
  const BATCH = 32;
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const v = await extractor(slice, { pooling: 'mean', normalize: true });
    const dim = v.dims[v.dims.length - 1];
    for (let j = 0; j < slice.length; j++) out.push(v.data.slice(j * dim, (j + 1) * dim));
    process.stderr.write(`  ${label}: ${Math.min(i + BATCH, texts.length)}/${texts.length}\r`);
  }
  process.stderr.write('\n');
  return out;
}

function shanghaiISO() {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  return t.toISOString().slice(0, -1) + '+08:00';
}

async function runScore(args) {
  const dataDir = resolveDataDir({ cliFlag: args.dataDir });
  const dirs = dataDirPaths(dataDir);
  const cfg = loadRelevance(dirs.relevance);
  setupProxy();
  setupTransformersCache(dataDir);

  const db = openDb(dirs.db);
  try {
    const keywordFilter = args.keyword ? [args.keyword] : null;
    const keywordRows = keywordFilter
      ? keywordFilter.map((k) => ({ keyword: k }))
      : db.prepare('SELECT DISTINCT keyword FROM sightings ORDER BY keyword').all();

    console.error(`[score] loading model ${MODEL_ID}`);
    const extractor = await pipeline('feature-extraction', MODEL_ID, { quantized: true });

    const allRows = db.prepare(
      'SELECT keyword, product_url, product_name, shop_name, raw_json FROM sightings'
    ).all();
    for (const r of allRows) {
      try { r.image_url = JSON.parse(r.raw_json)?.['商品图片链接'] ?? ''; }
      catch { r.image_url = ''; }
    }
    const docs = allRows.map((r) => r.shop_name ? `${r.product_name}。店铺：${r.shop_name}` : r.product_name);
    console.error(`[score] embedding ${docs.length} products`);
    const docVecs = await embedAll(extractor, docs, 'products');

    const byKeyword = new Map();
    for (let i = 0; i < allRows.length; i++) {
      const r = allRows[i];
      if (!byKeyword.has(r.keyword)) byKeyword.set(r.keyword, []);
      byKeyword.get(r.keyword).push({ row: r, vec: docVecs[i] });
    }

    const queryTexts = [];
    const queryMeta = [];
    for (const { keyword } of keywordRows) {
      const { positives, negatives } = tagsFor(cfg, keyword);
      const q = buildQueries(keyword, positives, negatives);
      queryTexts.push(q.v2);
      queryMeta.push({ kw: keyword, kind: 'v2' });
      if (q.neg) {
        queryTexts.push(q.neg);
        queryMeta.push({ kw: keyword, kind: 'neg' });
      }
    }
    console.error(`[score] embedding ${queryTexts.length} queries`);
    const queryVecs = await embedAll(extractor, queryTexts, 'queries');
    const qByKw = new Map();
    for (let i = 0; i < queryMeta.length; i++) {
      const m = queryMeta[i];
      if (!qByKw.has(m.kw)) qByKw.set(m.kw, {});
      qByKw.get(m.kw)[m.kind] = queryVecs[i];
    }

    const upsert = db.prepare(`
      INSERT INTO relevance_annotations
        (keyword, product_url, product_name, shop_name, image_url,
         decision_auto, score_v2, score_neg, score_v3, keyword_flag, scored_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(keyword, product_url) DO UPDATE SET
        product_name  = excluded.product_name,
        shop_name     = excluded.shop_name,
        image_url     = excluded.image_url,
        decision_auto = excluded.decision_auto,
        score_v2      = excluded.score_v2,
        score_neg     = excluded.score_neg,
        score_v3      = excluded.score_v3,
        keyword_flag  = excluded.keyword_flag,
        scored_at     = excluded.scored_at
    `);
    const updateFlag = db.prepare('UPDATE relevance_annotations SET keyword_flag=? WHERE keyword=?');

    const now = shanghaiISO();
    db.exec('BEGIN');
    try {
      for (const { keyword } of keywordRows) {
        const items = byKeyword.get(keyword) ?? [];
        if (!items.length) continue;
        const q = qByKw.get(keyword) ?? {};
        const v2List = [];
        for (const it of items) {
          const v2 = q.v2 ? cosine(q.v2, it.vec) : 0;
          const negSim = q.neg ? cosine(q.neg, it.vec) : 0;
          const v3 = v2 - cfg.thresholds.alpha * negSim;
          v2List.push(v2);
          const decision = v3 < cfg.thresholds.stage2 ? 'dropped' : 'kept';
          upsert.run(
            keyword, it.row.product_url, it.row.product_name, it.row.shop_name ?? null,
            it.row.image_url ?? null, decision, v2, negSim, v3, null, now,
          );
        }
        const v2Mean = v2List.reduce((a, b) => a + b, 0) / v2List.length;
        const flag = v2Mean < cfg.thresholds.stage1 ? 'low_signal' : 'ok';
        updateFlag.run(flag, keyword);
        console.error(`[score] ${keyword}: n=${items.length} v2_mean=${v2Mean.toFixed(3)} flag=${flag}`);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } finally {
    db.close();
  }
}

const EXPORT_FILTERS = {
  pending:           "decision_human IS NULL",
  low_signal_kept:   "decision_human IS NULL AND keyword_flag='low_signal' AND decision_auto='kept'",
  // Re-review pass: all products in low_signal keywords, regardless of prior
  // annotation. The xlsx pre-fills the "结果" column with the current
  // effective decision, so import-time UPDATE will overwrite past calls.
  low_signal_review: "keyword_flag='low_signal'",
  borderline:        "decision_human IS NULL AND decision_auto='kept' AND score_v3 < 0.40",
  dropped:           "decision_human IS NULL AND decision_auto='dropped'",
  all:               "1=1",
};

function todayInShanghai() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function pickExportPath(tasksDir, explicit) {
  if (explicit) return path.resolve(explicit);
  mkdirSync(tasksDir, { recursive: true });
  const doneDir = path.join(tasksDir, 'done');
  const date = todayInShanghai();
  for (let v = 1; v < 1000; v++) {
    const fname = `${date}-v${v}.xlsx`;
    const p = path.join(tasksDir, fname);
    const archived = path.join(doneDir, fname);
    if (!existsSync(p) && !existsSync(archived)) return p;
  }
  throw new Error('Too many versions for today');
}

async function runExport(args) {
  const dataDir = resolveDataDir({ cliFlag: args.dataDir });
  const dirs = dataDirPaths(dataDir);
  const filter = args.filter ?? 'pending';
  const where = EXPORT_FILTERS[filter];
  if (!where) {
    console.error(`Unknown --filter=${filter}. Options: ${Object.keys(EXPORT_FILTERS).join(', ')}`);
    process.exit(2);
  }

  const db = openDb(dirs.db);
  try {
    const params = [];
    let extraWhere = '';
    if (args.days) {
      extraWhere = ` AND s.updated_at >= ?`;
      const cutoff = new Date(Date.now() - args.days * 86400 * 1000 + 8 * 3600 * 1000);
      params.push(cutoff.toISOString().slice(0, -1) + '+08:00');
    }
    const sql = `
      SELECT
        ra.keyword, ra.product_url, ra.product_name, ra.shop_name, ra.image_url,
        ra.decision_auto, ra.decision_human, ra.score_v2, ra.score_neg, ra.score_v3,
        ra.keyword_flag, ra.human_note, s.qly_detail_url, s.updated_at
      FROM relevance_annotations ra
      JOIN sightings s ON s.keyword = ra.keyword AND s.product_url = ra.product_url
      WHERE ${where}${extraWhere}
      ORDER BY ra.score_v3 ASC
    `;
    const rows = db.prepare(sql).all(...params);
    if (!rows.length) {
      console.error(`[export] no rows match filter=${filter}${args.days ? ` days=${args.days}` : ''}`);
      return;
    }

    const outPath = pickExportPath(dirs.tasks, args.out);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('annotations');

    // Column order is optimized for review ergonomics: identifiers and auto
    // context up front, editable cells (结果 / 备注) in the middle, the long
    // URL last so it never pushes editable columns off-screen.
    const headers = ['关键词', '商品名', '店铺', '自动判断', 'score_v3', '结果', '备注', 'keyword_flag', '商品链接'];
    const headerRow = ws.addRow(headers);
    headerRow.font = { name: '微软雅黑', size: 11, bold: true };

    for (const r of rows) {
      const effective = r.decision_human ?? r.decision_auto;
      const resultCell = effective === 'kept' ? '保留' : effective === 'dropped' ? '丢弃' : '';
      ws.addRow([
        r.keyword,
        r.product_name,
        r.shop_name ?? '',
        r.decision_auto === 'kept' ? '保留' : '丢弃',
        Number(r.score_v3.toFixed(4)),
        resultCell,
        r.human_note ?? '',
        r.keyword_flag ?? '',
        r.product_url,
      ]);
    }

    const resultColIdx = headers.indexOf('结果') + 1;
    ws.getColumn(resultColIdx).font = { name: '微软雅黑', size: 11, bold: true, color: { argb: 'FFC00000' } };
    ws.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      row.eachCell((cell, colNum) => {
        if (colNum === resultColIdx) return;
        cell.font = { name: '微软雅黑', size: 11 };
      });
    });
    ws.columns.forEach((col, i) => {
      const widths = [12, 40, 20, 10, 10, 10, 30, 14, 60];
      col.width = widths[i] ?? 16;
    });
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: ws.rowCount, column: headers.length } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    await wb.xlsx.writeFile(outPath);
    console.error(`[export] wrote ${rows.length} rows to ${outPath}`);
  } finally {
    db.close();
  }
}
const RESULT_TO_DECISION = { '保留': 'kept', '丢弃': 'dropped' };

async function runImport(args) {
  if (!args.in) {
    console.error('Missing --in <xlsx>');
    process.exit(2);
  }
  const dataDir = resolveDataDir({ cliFlag: args.dataDir });
  const dirs = dataDirPaths(dataDir);
  const inPath = path.resolve(args.in);
  if (!existsSync(inPath)) {
    console.error(`File not found: ${inPath}`);
    process.exit(2);
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(inPath);
  const ws = wb.worksheets[0];
  if (!ws) {
    console.error('No worksheet in xlsx');
    process.exit(2);
  }

  const headers = {};
  ws.getRow(1).eachCell((cell, col) => {
    headers[String(cell.value ?? '').trim()] = col;
  });
  for (const required of ['关键词', '商品链接', '结果']) {
    if (!headers[required]) {
      console.error(`Missing required column: ${required}. Found: ${Object.keys(headers).join(', ')}`);
      process.exit(2);
    }
  }

  const db = openDb(dirs.db);
  const fetchAuto = db.prepare('SELECT decision_auto FROM relevance_annotations WHERE keyword=? AND product_url=?');
  const update = db.prepare('UPDATE relevance_annotations SET decision_human=?, human_note=? WHERE keyword=? AND product_url=?');

  let agree = 0, override = 0, invalid = 0, missingPK = 0;
  const warnings = [];

  if (!args.dryRun) db.exec('BEGIN');
  try {
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const get = (name) => String(row.getCell(headers[name]).value ?? '').trim();
      const keyword = get('关键词');
      const productUrl = get('商品链接');
      const result = get('结果');
      const note = headers['备注'] ? get('备注') : '';
      if (!keyword || !productUrl) {
        warnings.push(`row ${r}: missing 关键词 or 商品链接`);
        missingPK += 1;
        continue;
      }
      const decisionHuman = RESULT_TO_DECISION[result];
      if (!decisionHuman) {
        warnings.push(`row ${r}: 结果 must be 保留 or 丢弃 (got "${result}")`);
        invalid += 1;
        continue;
      }
      const existing = fetchAuto.get(keyword, productUrl);
      if (!existing) {
        warnings.push(`row ${r}: (${keyword}, ${productUrl.slice(0, 50)}…) not in DB`);
        missingPK += 1;
        continue;
      }
      if (decisionHuman === existing.decision_auto) agree += 1;
      else override += 1;
      if (!args.dryRun) update.run(decisionHuman, note || null, keyword, productUrl);
    }
    if (!args.dryRun) db.exec('COMMIT');
  } catch (err) {
    if (!args.dryRun) db.exec('ROLLBACK');
    db.close();
    throw err;
  }
  db.close();

  const total = agree + override;
  console.log(`Input:   ${inPath}`);
  console.log(`Applied: ${total}${args.dryRun ? '  (DRY RUN)' : ''}`);
  console.log(`  agree:    ${agree}`);
  console.log(`  override: ${override}`);
  if (invalid)   console.log(`Invalid 结果: ${invalid}`);
  if (missingPK) console.log(`Missing PK:  ${missingPK}`);
  if (warnings.length) {
    console.log(`\nWarnings (${warnings.length}):`);
    for (const w of warnings.slice(0, 20)) console.log(`  ${w}`);
    if (warnings.length > 20) console.log(`  ...(${warnings.length - 20} more)`);
  }

  if (!args.dryRun && !args.noArchive && total > 0) {
    const { renameSync } = await import('node:fs');
    mkdirSync(dirs.tasksDone, { recursive: true });
    let archived = path.join(dirs.tasksDone, path.basename(inPath));
    if (existsSync(archived)) {
      const ext = path.extname(archived);
      const base = archived.slice(0, -ext.length);
      for (let i = 2; i < 1000; i++) {
        const candidate = `${base}-r${i}${ext}`;
        if (!existsSync(candidate)) { archived = candidate; break; }
      }
    }
    renameSync(inPath, archived);
    console.log(`\nArchived to: ${archived}`);
  }
}
async function runAudit(args) {
  const dataDir = resolveDataDir({ cliFlag: args.dataDir });
  const dirs = dataDirPaths(dataDir);
  const db = openDb(dirs.db);
  try {
    const sql = `
      SELECT
        keyword,
        COUNT(*) AS n,
        SUM(CASE WHEN decision_auto = 'dropped' THEN 1 ELSE 0 END) AS n_dropped,
        SUM(CASE WHEN decision_human = 'dropped' THEN 1 ELSE 0 END) AS n_human_dropped,
        SUM(CASE WHEN decision_human = 'kept' THEN 1 ELSE 0 END) AS n_human_kept,
        AVG(score_v2) AS v2_mean,
        AVG(score_v3) AS v3_mean,
        MIN(score_v3) AS v3_min,
        MAX(keyword_flag) AS flag
      FROM relevance_annotations
      GROUP BY keyword
      ORDER BY keyword
    `;
    const rows = db.prepare(sql).all();
    if (!rows.length) {
      console.log('No annotations yet — run `relevance score` first.');
      return;
    }
    const fmt = (n, d = 3) => Number.isFinite(n) ? n.toFixed(d) : '—';
    console.log('keyword              | n   | drop | h_drop | h_keep | v2_mean | v3_min | flag');
    console.log('---------------------|-----|------|--------|--------|---------|--------|----------');
    for (const r of rows) {
      console.log(
        `${r.keyword.padEnd(20)} | ${String(r.n).padStart(3)} | ${String(r.n_dropped).padStart(4)} | ${String(r.n_human_dropped).padStart(6)} | ${String(r.n_human_kept).padStart(6)} | ${fmt(r.v2_mean).padStart(7)} | ${fmt(r.v3_min).padStart(6)} | ${r.flag ?? ''}`
      );
    }
  } finally {
    db.close();
  }
}

function parseArgs(argv) {
  const sub = argv[2];
  const out = { sub, dataDir: undefined };
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === '--data-dir')   out.dataDir = argv[++i];
    else if (argv[i] === '--keyword') out.keyword = argv[++i];
    else if (argv[i] === '--out')   out.out = argv[++i];
    else if (argv[i] === '--in')    out.in = argv[++i];
    else if (argv[i] === '--days')  out.days = Number(argv[++i]);
    else if (argv[i] === '--filter') out.filter = argv[++i];
    else if (argv[i] === '--dry-run') out.dryRun = true;
    else if (argv[i] === '--no-archive') out.noArchive = true;
  }
  return out;
}

const SUBCOMMANDS = {
  score: runScore,
  export: runExport,
  import: runImport,
  audit: runAudit,
};

async function main() {
  const args = parseArgs(process.argv);
  if (!args.sub || !SUBCOMMANDS[args.sub]) {
    console.error(`Usage: node relevance.mjs <score|export|import|audit> [...flags]`);
    process.exit(2);
  }
  await SUBCOMMANDS[args.sub](args);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
