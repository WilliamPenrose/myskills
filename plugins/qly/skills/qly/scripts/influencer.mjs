// influencer.mjs — plan (weekly tracking xlsx) + fetch (KOL scrape).
//
// Usage:
//   node influencer.mjs plan [--min-gmv N]
//   node influencer.mjs fetch --from-xlsx <path> [--time 7] [--type live] [--window-days 7] [--retry 1h] [--force] [--limit N] [--dry-run]
//   node influencer.mjs fetch --pids <csv>

import process from 'node:process';
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import ExcelJS from 'exceljs';

import { resolveDataDir, dataDirPaths } from './_lib/paths.mjs';
import { openDb } from './_lib/db.mjs';
import { loadConfig } from './_lib/config.mjs';
import { decideConclusion, gateDecision, parseDuration } from './_lib/influencer-helpers.mjs';
import { createQlyRuntime, createSecurePuppeteerPrimitives } from './_lib/bootstrap.mjs';
import { extractInfluencerUids } from './_lib/influencer-extract.mjs';
import { redirectStderrToLog } from './_lib/log-redirect.mjs';

function todayShanghai() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function shanghaiISO() {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  return t.toISOString().slice(0, -1) + '+08:00';
}

function pickTrackingPath(tasksDir, date) {
  mkdirSync(tasksDir, { recursive: true });
  const base = path.join(tasksDir, `tracking-${date}.xlsx`);
  if (!existsSync(base)) return base;
  for (let v = 2; v < 1000; v++) {
    const p = path.join(tasksDir, `tracking-${date}-v${v}.xlsx`);
    if (!existsSync(p)) return p;
  }
  throw new Error('Too many versions for today');
}

function extractRaw(rawJson) {
  let obj = {};
  try { obj = JSON.parse(rawJson || '{}'); } catch { /* ignore */ }
  const num = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    sales7d:  num(obj['7日总销量']),
    gmv7d:    num(obj['7日销售额']),
    sales30d: num(obj['30日总销量']),
    gmv30d:   num(obj['30日销售额']),
    price:    num(obj['价格']),
  };
}

async function runPlan(args) {
  const dataDir = resolveDataDir({ cliFlag: args.dataDir });
  const dirs = dataDirPaths(dataDir);
  const config = loadConfig(dirs.config);
  const minGmv = args.minGmv ?? config.influencer.min_gmv;

  const db = openDb(dirs.db);
  try {
    const cutoff = new Date(Date.now() - 7 * 86400 * 1000 + 8 * 3600 * 1000)
      .toISOString().slice(0, -1) + '+08:00';
    const sql = `
      WITH pid_rows AS (
        SELECT
          SUBSTR(s.qly_detail_url, INSTR(s.qly_detail_url, 'pId=') + 4) AS pid,
          s.keyword, s.product_url, s.product_name, s.shop_name,
          s.observed_at, s.updated_at, s.raw_json,
          COALESCE(ra.decision_human, ra.decision_auto) AS effective
        FROM sightings s
        LEFT JOIN relevance_annotations ra
          ON ra.keyword = s.keyword AND ra.product_url = s.product_url
      ),
      week_pids AS (SELECT DISTINCT pid FROM pid_rows WHERE updated_at >= ?),
      freshest AS (
        SELECT p.pid, MAX(p.updated_at) AS max_upd
        FROM pid_rows p JOIN week_pids w ON w.pid = p.pid GROUP BY p.pid
      )
      SELECT
        w.pid,
        (SELECT product_name FROM pid_rows q WHERE q.pid=w.pid AND q.updated_at=f.max_upd LIMIT 1) AS product_name,
        (SELECT shop_name    FROM pid_rows q WHERE q.pid=w.pid AND q.updated_at=f.max_upd LIMIT 1) AS shop_name,
        (SELECT raw_json     FROM pid_rows q WHERE q.pid=w.pid AND q.updated_at=f.max_upd LIMIT 1) AS raw_json,
        (SELECT MIN(observed_at) FROM pid_rows q WHERE q.pid=w.pid) AS observed_at,
        f.max_upd AS updated_at,
        (SELECT GROUP_CONCAT(DISTINCT keyword) FROM pid_rows q WHERE q.pid=w.pid) AS hit_keywords,
        (SELECT SUM(CASE WHEN effective='kept' THEN 1 ELSE 0 END) FROM pid_rows q WHERE q.pid=w.pid) AS n_kept,
        (SELECT SUM(CASE WHEN effective='dropped' THEN 1 ELSE 0 END) FROM pid_rows q WHERE q.pid=w.pid) AS n_dropped
      FROM week_pids w JOIN freshest f ON f.pid = w.pid
    `;
    const rows = db.prepare(sql).all(cutoff);

    const enriched = rows.map((r) => {
      const raw = extractRaw(r.raw_json);
      return {
        pid: r.pid,
        product_name: r.product_name,
        shop_name: r.shop_name ?? '',
        hit_keywords: r.hit_keywords,
        n_kept: r.n_kept ?? 0,
        n_dropped: r.n_dropped ?? 0,
        sales7d: raw.sales7d,
        gmv7d: raw.gmv7d,
        sales30d: raw.sales30d,
        gmv30d: raw.gmv30d,
        observed_at: r.observed_at,
        updated_at: r.updated_at,
        是否新增: new Date(r.observed_at).getTime() >= Date.now() - 7 * 86400 * 1000 ? '新' : '旧',
      };
    });
    enriched.sort((a, b) => (b.gmv7d ?? 0) - (a.gmv7d ?? 0));

    for (const r of enriched) {
      r.结论 = decideConclusion({
        nKept: r.n_kept, nDropped: r.n_dropped, gmv7d: r.gmv7d, minGmv,
      });
    }

    const outPath = pickTrackingPath(dirs.tasks, todayShanghai());
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('tracking');
    const headers = ['pid', 'product_name', 'shop_name', 'hit_keywords', 'n_kept', 'n_dropped',
                     '7日销售额', '7日总销量', '30日销售额', '30日总销量', '是否新增', '结论'];
    const headerRow = ws.addRow(headers);
    headerRow.font = { name: '微软雅黑', size: 11, bold: true };
    for (const r of enriched) {
      ws.addRow([
        r.pid, r.product_name, r.shop_name, r.hit_keywords,
        r.n_kept, r.n_dropped, r.gmv7d ?? '', r.sales7d ?? '',
        r.gmv30d ?? '', r.sales30d ?? '', r.是否新增, r.结论,
      ]);
    }
    ws.eachRow((row, n) => {
      if (n === 1) return;
      row.eachCell((cell) => { cell.font = { name: '微软雅黑', size: 11 }; });
    });
    const conclCol = headers.indexOf('结论') + 1;
    ws.getColumn(conclCol).font = { name: '微软雅黑', size: 11, bold: true, color: { argb: 'FFC00000' } };
    ws.columns.forEach((col, i) => {
      const widths = [22, 40, 20, 30, 6, 8, 12, 12, 12, 12, 8, 18];
      col.width = widths[i] ?? 14;
    });
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: ws.rowCount, column: headers.length } };
    ws.views = [{ state: 'frozen', xSplit: 4, ySplit: 1 }];
    await wb.xlsx.writeFile(outPath);
    console.error(`[plan] wrote ${enriched.length} rows to ${outPath}`);
  } finally {
    db.close();
  }
}

async function runFetch(args) { throw new Error('fetch not yet implemented'); }

function parseArgs(argv) {
  const sub = argv[2];
  const out = { sub };
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data-dir')        out.dataDir = argv[++i];
    else if (a === '--from-xlsx')  out.fromXlsx = argv[++i];
    else if (a === '--pids')       out.pids = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--time')       out.time = Number(argv[++i]);
    else if (a === '--type')       { const v = argv[++i]; out.type = v === '_' ? '' : v; }
    else if (a === '--window-days')out.windowDays = Number(argv[++i]);
    else if (a === '--retry')      out.retryAfterMs = parseDuration(argv[++i]);
    else if (a === '--limit')      out.limit = Number(argv[++i]);
    else if (a === '--min-gmv')    out.minGmv = Number(argv[++i]);
    else if (a === '--force')      out.force = true;
    else if (a === '--dry-run')    out.dryRun = true;
  }
  out.time = out.time ?? 7;
  out.type = out.type ?? 'live';
  out.windowDays = out.windowDays ?? 7;
  out.retryAfterMs = out.retryAfterMs ?? null;
  out.force = out.force ?? false;
  out.dryRun = out.dryRun ?? false;
  return out;
}

const SUBCOMMANDS = { plan: runPlan, fetch: runFetch };

async function main() {
  const args = parseArgs(process.argv);
  if (!args.sub || !SUBCOMMANDS[args.sub]) {
    console.error(`Usage: node influencer.mjs <plan|fetch> [...flags]`);
    process.exit(2);
  }
  await SUBCOMMANDS[args.sub](args);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
