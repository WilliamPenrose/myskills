// One-time backfill for shop_name.
//
// The original products.mjs importer only looked for r['店铺'] / r['店铺名'],
// but qlydata's xlsx export actually uses 小店名称. Every row landed in
// sightings since the rewrite has shop_name = NULL. raw_json still holds the
// original row, so we can recover the value without re-scraping.
//
// This script:
//   1. UPDATE sightings.shop_name from raw_json['小店名称'] where missing.
//   2. UPDATE relevance_annotations.shop_name from the now-correct sightings.
//
// Usage:
//   node backfill-shop-name.mjs                      use default data dir
//   node backfill-shop-name.mjs --data-dir <path>    override
//   node backfill-shop-name.mjs --dry-run            count only, no writes

import process from 'node:process';
import { resolveDataDir, dataDirPaths } from '../_lib/paths.mjs';
import { openDb } from '../_lib/db.mjs';

function parseArgs(argv) {
  const out = { dataDir: undefined, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--data-dir')      out.dataDir = argv[++i];
    else if (argv[i] === '--dry-run')  out.dryRun = true;
  }
  return out;
}

function extractShopName(rawJson) {
  if (!rawJson) return null;
  let obj;
  try { obj = JSON.parse(rawJson); } catch { return null; }
  const v = obj?.['小店名称'] ?? obj?.['店铺'] ?? obj?.['店铺名'];
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

function main() {
  const args = parseArgs(process.argv);
  const dataDir = resolveDataDir({ cliFlag: args.dataDir });
  const dirs = dataDirPaths(dataDir);
  console.log(`[backfill] data-dir=${dataDir}`);

  const db = openDb(dirs.db);

  const targets = db.prepare(`
    SELECT keyword, product_url, raw_json
    FROM sightings
    WHERE (shop_name IS NULL OR shop_name = '')
      AND raw_json IS NOT NULL
  `).all();

  console.log(`[backfill] sightings rows missing shop_name: ${targets.length}`);

  const updateSighting = db.prepare(
    'UPDATE sightings SET shop_name = ? WHERE keyword = ? AND product_url = ?'
  );

  let sFilled = 0;
  let sNoData = 0;
  if (!args.dryRun) db.exec('BEGIN');
  try {
    for (const row of targets) {
      const shop = extractShopName(row.raw_json);
      if (!shop) { sNoData += 1; continue; }
      if (!args.dryRun) updateSighting.run(shop, row.keyword, row.product_url);
      sFilled += 1;
    }
    if (!args.dryRun) db.exec('COMMIT');
  } catch (err) {
    if (!args.dryRun) db.exec('ROLLBACK');
    throw err;
  }
  console.log(`[backfill] sightings: filled=${sFilled} no_data_in_raw=${sNoData}`);

  // Propagate to relevance_annotations.
  const raTargets = db.prepare(`
    SELECT ra.keyword, ra.product_url, s.shop_name AS new_shop
    FROM relevance_annotations ra
    JOIN sightings s
      ON s.keyword = ra.keyword AND s.product_url = ra.product_url
    WHERE (ra.shop_name IS NULL OR ra.shop_name = '')
      AND s.shop_name IS NOT NULL AND s.shop_name <> ''
  `).all();

  console.log(`[backfill] relevance_annotations rows to fill: ${raTargets.length}`);

  const updateRa = db.prepare(
    'UPDATE relevance_annotations SET shop_name = ? WHERE keyword = ? AND product_url = ?'
  );

  let raFilled = 0;
  if (!args.dryRun) db.exec('BEGIN');
  try {
    for (const row of raTargets) {
      if (!args.dryRun) updateRa.run(row.new_shop, row.keyword, row.product_url);
      raFilled += 1;
    }
    if (!args.dryRun) db.exec('COMMIT');
  } catch (err) {
    if (!args.dryRun) db.exec('ROLLBACK');
    throw err;
  }
  console.log(`[backfill] relevance_annotations: filled=${raFilled}`);

  if (args.dryRun) console.log('[backfill] dry-run — no changes written');

  db.close();
}

main();
