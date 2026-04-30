#!/usr/bin/env node
import './_lib/proxy.mjs';
import './_lib/silence-warnings.mjs';
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
  --lang <code>         REQUIRED for --platform play; REJECTED for --platform ios
  --sort <newest|relevant|rating>   default: newest
  --limit <n>           default: 100
  --force               required to exceed the iOS soft cap (100)
  --data-dir <path>     override data directory (default: project-local .app-reviews/)

Notes on --lang:
  Google Play's reviews endpoint filters reviews by hl, not gl. Omitting hl
  silently returns a global English fallback set, which is data your agent
  almost never wants. Therefore --lang is required for play; the script will
  not guess. Apple's reviews endpoint ignores the language parameter, so
  passing --lang for ios is treated as a usage error.

Notes on iOS rate limits:
  iOS pulls are aggressively rate-limited (HTTP 429) by Apple's per-page-size-10
  catalog API. Pulling >100 for one country routinely costs many minutes of
  exponential-backoff. To prevent agents from burning that time silently, iOS
  fetches >100 require --force.

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
    if (a === '--force')     { args.force = true; continue; }
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
  if (args.platform === 'play' && !args.lang) {
    console.error(
      '--platform play requires --lang.\n' +
      'Pass the dominant language for the target country, e.g.:\n' +
      '  country=tw -> --lang zh-TW\n' +
      '  country=jp -> --lang ja\n' +
      '  country=br -> --lang pt-BR\n' +
      "Note: Google Play's reviews endpoint filters by hl, not gl.\n" +
      'Without --lang you would silently get a global English fallback set.',
    );
    process.exit(1);
  }
  if (args.platform === 'ios' && args.lang) {
    console.error(
      '--platform ios does not accept --lang.\n' +
      "Apple's reviews endpoint ignores the language parameter; passing it\n" +
      'suggests a misunderstanding of the API. Pass only --country for ios.',
    );
    process.exit(1);
  }
  const IOS_SOFT_CAP = 100;
  if (args.platform === 'ios' && args.limit > IOS_SOFT_CAP && !args.force) {
    console.error(
      `iOS --limit ${args.limit} exceeds the soft cap of ${IOS_SOFT_CAP}.\n` +
      `Apple's reviews API is heavily rate-limited (page size is 10, and 429s\n` +
      `kick in quickly under burst load). Pulling >${IOS_SOFT_CAP} reviews for one\n` +
      `country routinely costs many minutes of exponential backoff and often\n` +
      `still fails. Try --limit ${IOS_SOFT_CAP} (recent reviews are usually enough\n` +
      `to surface the dominant complaints), or pass --force to override if you\n` +
      `truly need a deeper pull and accept the wait.`,
    );
    process.exit(1);
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
  // For iOS, the language parameter is not meaningful (Apple's endpoint
  // ignores it). We store '' rather than 'en' to avoid the misleading
  // implication that iOS rows are English-only when in fact they are in
  // whatever language the user wrote. Empty string keeps the existing
  // NOT NULL schema constraint without requiring a migration.
  const lang = args.platform === 'play' ? args.lang.toLowerCase() : '';

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
