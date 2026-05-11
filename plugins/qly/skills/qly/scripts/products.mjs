// products.mjs — drive qlydata to harvest products per keyword, land in sightings.
//
// Combines stage2-batch + stage2-pipeline + import-xlsxs-to-db from .dev/scripts/qlydata/.
//
// Usage:
//   node products.mjs                          read keywords from config.keywords_source
//   node products.mjs --keywords-xlsx <path>   temp override path
//   node products.mjs --keywords 自然拼读       ad-hoc single keyword (bypass xlsx)
//   node products.mjs --rescrape 自然拼读       force rescrape (delete prior xlsx)
//   node products.mjs --data-dir <path>        override data dir

import { existsSync, readdirSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ExcelJS from 'exceljs';

import { resolveDataDir, dataDirPaths } from './_lib/paths.mjs';
import { openDb } from './_lib/db.mjs';
import { loadConfig } from './_lib/config.mjs';
import { loadKeywords } from './_lib/keyword-source.mjs';
import { createQlyRuntime, createSecurePuppeteerPrimitives } from './_lib/bootstrap.mjs';
import {
  setPriceRange,
  setLivestreamSales,
  searchKeyword,
  triggerExport,
} from './_lib/actions.mjs';
import { assertSession } from './_lib/session.mjs';
import { redirectStderrToLog } from './_lib/log-redirect.mjs';

const TARGET_HOST = 'qlydata.com';
const GOODS_SEARCH_URL = 'https://qlydata.com/#/market_rank/goods/goods_search';
const HASH_INVARIANT = '#/market_rank/goods/goods_search';

function parseArgs(argv) {
  const out = {
    dataDir: undefined,
    keywordsXlsx: undefined,
    keywords: undefined,
    rescrape: undefined,
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--data-dir')           out.dataDir = argv[++i];
    else if (argv[i] === '--keywords-xlsx') out.keywordsXlsx = argv[++i];
    else if (argv[i] === '--keywords')      out.keywords = argv[++i];
    else if (argv[i] === '--rescrape')      out.rescrape = argv[++i];
  }
  if (out.keywordsXlsx && out.keywords) {
    throw new Error('--keywords-xlsx and --keywords are mutually exclusive');
  }
  return out;
}

function safeFs(s) { return String(s).replace(/[\\/:*?"<>|]/g, '_'); }

function exportFilenamePattern(keyword, price, sales) {
  return `qlydata-{stamp}-price${price.min}-${price.max}-sales${sales.min}-${sales.max}-${safeFs(keyword)}.xlsx`;
}

function keywordFilenameRegex(keyword) {
  const escaped = safeFs(keyword).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`-${escaped}\\.xlsx$`);
}

function isAlreadyExported(exportsDir, keyword) {
  if (!existsSync(exportsDir)) return false;
  const re = keywordFilenameRegex(keyword);
  return readdirSync(exportsDir).some((f) => re.test(f));
}

function deletePriorExports(exportsDir, keyword) {
  if (!existsSync(exportsDir)) return;
  const re = keywordFilenameRegex(keyword);
  for (const f of readdirSync(exportsDir)) {
    if (re.test(f)) unlinkSync(path.join(exportsDir, f));
  }
}

async function parseXlsxForSightings(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const header = [];
  ws.getRow(1).eachCell((cell, col) => { header[col - 1] = String(cell.value ?? '').trim(); });

  const out = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const obj = {};
    let hasAny = false;
    for (let c = 1; c <= header.length; c++) {
      const v = ws.getRow(r).getCell(c).value;
      obj[header[c - 1]] = v == null ? '' : (typeof v === 'object' && 'text' in v ? v.text : String(v));
      if (obj[header[c - 1]] !== '') hasAny = true;
    }
    if (hasAny) out.push(obj);
  }
  return out;
}

function shanghaiISO() {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  return t.toISOString().slice(0, -1) + '+08:00';
}

function upsertSightings(db, keyword, rows) {
  const stmt = db.prepare(`
    INSERT INTO sightings (keyword, product_url, observed_at, updated_at, product_name, shop_name, qly_detail_url, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(keyword, product_url) DO UPDATE SET
      updated_at = excluded.updated_at,
      product_name = excluded.product_name,
      shop_name = excluded.shop_name,
      qly_detail_url = excluded.qly_detail_url,
      raw_json = excluded.raw_json
  `);
  const checkExisting = db.prepare('SELECT 1 FROM sightings WHERE keyword=? AND product_url=?');
  const now = shanghaiISO();
  let inserted = 0;
  let updated = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const productUrl = r['商品链接'] ?? '';
      if (!productUrl) continue;
      const productName = r['商品名'] ?? r['商品名称'] ?? '';
      const shopName = r['店铺'] ?? r['店铺名'] ?? null;
      const detailUrl = r['详情链接'] ?? r['qly_detail_url'] ?? '';
      const rawJson = JSON.stringify(r);
      const exists = checkExisting.get(keyword, productUrl);
      stmt.run(keyword, productUrl, now, now, productName, shopName, detailUrl || null, rawJson);
      if (exists) updated += 1; else inserted += 1;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { inserted, updated };
}

async function ensureGoodsSearchTab(browser) {
  const pages = await browser.pages();
  let target = null;
  for (const p of pages) {
    try {
      const u = p.url();
      if (u.includes(TARGET_HOST)) { target = p; break; }
    } catch { /* ignore */ }
  }
  if (!target) target = await browser.newPage();
  await target.bringToFront();
  const u = target.url();
  if (!u.includes(HASH_INVARIANT)) {
    await target.goto(GOODS_SEARCH_URL, { waitUntil: 'domcontentloaded' });
  }
  return target;
}

function requireSuccess(result, step, keyword) {
  if (!result || result.success === false) {
    throw new Error(`${step} failed for ${keyword}: ${result?.reason ?? 'unknown'}`);
  }
  return result;
}

async function importExistingXlsxs(db, keyword, exportsDir, term) {
  if (!existsSync(exportsDir)) return;
  const re = keywordFilenameRegex(keyword);
  for (const f of readdirSync(exportsDir)) {
    if (!re.test(f)) continue;
    const rows = await parseXlsxForSightings(path.join(exportsDir, f));
    const r = upsertSightings(db, keyword, rows);
    term(`[products] ${keyword}: upsert +${r.inserted} ^${r.updated}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const dataDir = resolveDataDir({ cliFlag: args.dataDir });
  const dirs = dataDirPaths(dataDir);
  const { term } = redirectStderrToLog('products', dirs.logs);
  term(`[products] data-dir=${dataDir}`);

  const config = loadConfig(dirs.config);
  const price = { min: config.filters.price[0], max: config.filters.price[1] };
  const sales = { min: config.filters.live_sales[0], max: config.filters.live_sales[1] };

  let keywords;
  if (args.keywords) {
    keywords = [{ key_word: args.keywords }];
  } else if (args.rescrape) {
    keywords = [{ key_word: args.rescrape }];
    mkdirSync(dirs.exports, { recursive: true });
    deletePriorExports(dirs.exports, args.rescrape);
  } else {
    const sourcePath = args.keywordsXlsx ?? config.keywords_source.path;
    if (!existsSync(sourcePath)) {
      term(`[products] keyword source missing: ${sourcePath}`);
      process.exit(1);
    }
    keywords = await loadKeywords(sourcePath);
  }
  term(`[products] loaded ${keywords.length} keyword(s)`);

  mkdirSync(dirs.exports, { recursive: true });
  const db = openDb(dirs.db);

  const todo = [];
  for (const k of keywords) {
    if (isAlreadyExported(dirs.exports, k.key_word)) {
      term(`[products] skip already-exported: ${k.key_word}`);
    } else {
      todo.push(k);
    }
  }
  term(`[products] todo=${todo.length} skipped=${keywords.length - todo.length}`);

  if (!todo.length) {
    for (const k of keywords) {
      await importExistingXlsxs(db, k.key_word, dirs.exports, term);
    }
    db.close();
    return;
  }

  const runtime = createQlyRuntime();
  const browser = await runtime.ensureBrowser({ autoLaunch: true });
  const page = await ensureGoodsSearchTab(browser);
  const primitives = createSecurePuppeteerPrimitives({
    page,
    throttle: { minDelay: 1000, maxDelay: 2000 },
  });

  for (const k of todo) {
    term(`\n[products] >>> ${k.key_word}`);
    try {
      await assertSession(page);
      requireSuccess(await setPriceRange(primitives, { min: price.min, max: price.max }), 'price', k.key_word);
      requireSuccess(await setLivestreamSales(primitives, { min: sales.min, max: sales.max }), 'sales', k.key_word);
      await assertSession(page);
      requireSuccess(await searchKeyword(primitives, { keyword: k.key_word }), 'search', k.key_word);
      const result = requireSuccess(await triggerExport(primitives, {
        page,
        downloadDir: dirs.exports,
        filenamePattern: exportFilenamePattern(k.key_word, price, sales),
      }), 'export', k.key_word);
      const rows = await parseXlsxForSightings(result.filePath);
      const r = upsertSightings(db, k.key_word, rows);
      term(`[products] ${k.key_word}: rows=${rows.length} +${r.inserted} ^${r.updated}`);
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (msg.includes('今日访问次数已达上限') || msg.includes('quota')) {
        term(`[products] QUOTA HIT — exiting cleanly. Re-run tomorrow to continue.`);
        db.close();
        process.exit(1);
      }
      if (msg.includes('session') || msg.includes('未登录')) {
        term(`[products] SESSION EXPIRED — log in qlydata.com in chrome and re-run.`);
        db.close();
        process.exit(1);
      }
      term(`[products] ${k.key_word} FAILED: ${msg}`);
    }
  }

  db.close();
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
