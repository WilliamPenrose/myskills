#!/usr/bin/env node
import './_lib/silence-warnings.mjs';
import './_lib/proxy.mjs';
import { fetchPlayReviews } from './_lib/play.mjs';
import { fetchIosReviews } from './_lib/ios.mjs';
import { resolveProduct, bootstrapIfMissing, getProductsPath, resolveDataDir } from './_lib/products.mjs';
import { resolveDbPath, openDb, appReviewKey, countReviews, upsertReview } from './_lib/db.mjs';

const HELP = `
fetch --product <name> --platform <play|ios> [options]

Required:
  --product <name>      product canonical name or alias
  --platform <play|ios>

Optional:
  --country <code>      override product's default_country
  --lang <code>         Play only; ignored for iOS
  --sort <newest|relevant|rating>   default: newest
  --limit <n>           default: 100
  --data-dir <path>     override data directory (default: project-local .app-reviews/)

Data directory resolution order:
  1) --data-dir flag
  2) APP_REVIEWS_DATA_DIR env var
  3) nearest existing .app-reviews/ walking up from CWD
  4) <git-root>/.app-reviews/ if CWD is in a git repo
  5) <CWD>/.app-reviews/
`.trim();

function parseArgs(argv) {
  const args = { sort: 'newest', limit: 100 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { args.help = true; continue; }
    if (a === '--product')   { args.product = argv[++i]; continue; }
    if (a === '--platform')  { args.platform = argv[++i]; continue; }
    if (a === '--country')   { args.country = argv[++i]; continue; }
    if (a === '--lang')      { args.lang = argv[++i]; continue; }
    if (a === '--sort')      { args.sort = argv[++i]; continue; }
    if (a === '--limit')     { args.limit = parseInt(argv[++i], 10); continue; }
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
  if (!args.product || !args.platform) { console.error(HELP); process.exit(1); }
  if (args.platform !== 'play' && args.platform !== 'ios') {
    console.error('--platform must be "play" or "ios"'); process.exit(1);
  }
  if (!['newest', 'relevant', 'rating'].includes(args.sort)) {
    console.error('--sort must be one of newest|relevant|rating'); process.exit(1);
  }
  if (!Number.isInteger(args.limit) || args.limit < 1) {
    console.error('--limit must be a positive integer'); process.exit(1);
  }

  const dataDir = resolveDataDir({ flagValue: args.dataDir });
  console.error(`data dir: ${dataDir}`);

  if (bootstrapIfMissing(dataDir)) {
    console.error(`created empty products.json at ${getProductsPath(dataDir)}, fill in your products before running fetch`);
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
    console.error(`product "${product.canonical}" has no ${args.platform} app id configured in products.json`);
    process.exit(1);
  }
  const country = (args.country ?? product.default_country).toLowerCase();
  const lang = (args.lang ?? product.default_lang).toLowerCase();

  const dbPath = resolveDbPath(dataDir);
  const db = openDb(dbPath);
  const before = countReviews(db, product.canonical, args.platform);
  const fetchedAt = new Date().toISOString();

  console.error(`fetch ${product.canonical}/${args.platform} country=${country} sort=${args.sort} limit=${args.limit}`);

  const fetcher = args.platform === 'play'
    ? fetchPlayReviews({ appId, country, lang, sort: args.sort, limit: args.limit })
    : fetchIosReviews({ appId, country, sort: args.sort, limit: args.limit });

  let result;
  try {
    result = await fetcher;
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }

  for (const r of result.reviews) {
    const row = {
      review_key: appReviewKey({ platform: args.platform, app_id: appId, country, review_id: r.reviewId }),
      product_key: product.canonical,
      platform: args.platform,
      app_id: appId,
      country,
      lang,
      sort: args.sort,
      review_id: r.reviewId,
      user_name: r.userName,
      user_url: r.userUrl,
      user_image: r.userImage,
      rating: r.rating,
      title: r.title,
      content: r.content,
      helpful_count: r.helpfulCount,
      helpful_total: r.helpfulTotal,
      review_created_version: r.reviewCreatedVersion,
      app_version: r.appVersion,
      reviewed_at: r.reviewedAt,
      reply_content: r.replyContent,
      replied_at: r.repliedAt,
      first_seen_at: fetchedAt,
      fetched_at: fetchedAt,
      raw_json: JSON.stringify(r.raw),
    };
    upsertReview(db, row);
  }

  const after = countReviews(db, product.canonical, args.platform);
  const newCount = after - before;
  const updatedCount = result.reviews.length - newCount;

  console.error(`done: ${result.reviews.length} fetched in ${result.pages} pages, ${newCount} new / ${updatedCount} updated`);
}

main().catch((e) => {
  console.error(`fatal: ${e.stack || e.message}`);
  process.exit(1);
});
