#!/usr/bin/env node
import './_lib/proxy.mjs';
import './_lib/silence-warnings.mjs';
import * as fs from 'node:fs';
import { fetchPageRaw } from './_lib/play.mjs';
import { fetchFirstPage } from './_lib/ios.mjs';
import { resolveProduct, bootstrapIfMissing, getProductsPath, resolveDataDir } from './_lib/products.mjs';

const HELP = `
dump-raw --product <name> --platform <play|ios> --out <path> [options]

Required:
  --product <name>      product canonical name or alias
  --platform <play|ios>
  --out <path>          file to write the raw response to

Optional:
  --country <code>      override product's default_country
  --lang <code>         REQUIRED for --platform play; REJECTED for --platform ios
  --data-dir <path>     override data directory

Pulls one page of the raw response (size 10) and writes it to --out.
Used for diagnosing scraper drift; does not normalize, does not touch DB.
See references/repairing-scrapers.md.
`.trim();

const DUMP_PAGE_SIZE = 10;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { args.help = true; continue; }
    if (a === '--product')   { args.product = argv[++i]; continue; }
    if (a === '--platform')  { args.platform = argv[++i]; continue; }
    if (a === '--country')   { args.country = argv[++i]; continue; }
    if (a === '--lang')      { args.lang = argv[++i]; continue; }
    if (a === '--out')       { args.out = argv[++i]; continue; }
    if (a === '--data-dir')  { args.dataDir = argv[++i]; continue; }
    throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    console.error(HELP);
    process.exit(1);
  }
  if (args.help) { console.error(HELP); process.exit(0); }
  if (!args.product || !args.platform || !args.out) { console.error(HELP); process.exit(1); }
  if (args.platform !== 'play' && args.platform !== 'ios') {
    console.error('--platform must be "play" or "ios"'); process.exit(1);
  }
  if (args.platform === 'play' && !args.lang) {
    console.error('--platform play requires --lang (e.g. en, zh-TW, ja).'); process.exit(1);
  }
  if (args.platform === 'ios' && args.lang) {
    console.error('--platform ios does not accept --lang.'); process.exit(1);
  }

  const dataDir = resolveDataDir({ flagValue: args.dataDir });
  console.error(`data dir: ${dataDir}`);

  if (bootstrapIfMissing(dataDir)) {
    console.error(`created empty products.json at ${getProductsPath(dataDir)}, fill in your products first`);
    process.exit(1);
  }

  let product;
  try {
    product = resolveProduct(dataDir, args.product);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  const appId = args.platform === 'play' ? product.play : product.ios;
  if (!appId) {
    console.error(`product "${product.canonical}" has no ${args.platform} app id configured`);
    process.exit(1);
  }
  const country = (args.country ?? product.default_country).toLowerCase();

  let body;
  if (args.platform === 'play') {
    const inner = await fetchPageRaw({
      appId, country, lang: args.lang.toLowerCase(),
      sort: 'newest', count: DUMP_PAGE_SIZE, paginationToken: null,
    });
    body = JSON.stringify(JSON.parse(inner), null, 2);
  } else {
    const json = await fetchFirstPage({
      appId, country, sort: 'newest', pageSize: DUMP_PAGE_SIZE,
    });
    body = JSON.stringify(json, null, 2);
  }

  fs.writeFileSync(args.out, body, 'utf8');
  console.error(`wrote ${body.length} bytes to ${args.out}`);
}

main().catch((e) => {
  console.error(`fatal: ${e.stack || e.message}`);
  process.exit(1);
});
