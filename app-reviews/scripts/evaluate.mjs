#!/usr/bin/env node
import './_lib/silence-warnings.mjs';
import {
  resolveDbPath, openDb, selectReviewsForEvaluate,
  clearFeaturesPassed, upsertFeature,
} from './_lib/db.mjs';
import { resolveProduct, bootstrapIfMissing, getProductsPath, resolveDataDir } from './_lib/products.mjs';
import {
  computeSignalFlags, signalNamesFromFlags, countWords, analysisValueScore,
} from './_lib/signals.mjs';

const HELP = `
evaluate --product <name> [options]

Required:
  --product <name>      product canonical name or alias

Optional:
  --platform <play|ios|both>   default: both
  --top <n>                    selection limit, default: 300
  --long-chars <n>             long_review threshold, default: 120
  --signal-chars <n>           signal_review threshold, default: 80
  --data-dir <path>            override data directory (default: project-local .app-reviews/)
`.trim();

function parseArgs(argv) {
  const args = { platform: 'both', top: 300, longChars: 120, signalChars: 80 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { args.help = true; continue; }
    if (a === '--product')      { args.product = argv[++i]; continue; }
    if (a === '--platform')     { args.platform = argv[++i]; continue; }
    if (a === '--top')          { args.top = parseInt(argv[++i], 10); continue; }
    if (a === '--long-chars')   { args.longChars = parseInt(argv[++i], 10); continue; }
    if (a === '--signal-chars') { args.signalChars = parseInt(argv[++i], 10); continue; }
    if (a === '--data-dir')     { args.dataDir = argv[++i]; continue; }
    throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function computeFeature(row, args, evaluatedAt) {
  const title = (row.title ?? '').trim();
  const content = (row.content ?? '').trim();
  const combined = `${title}\n${content}`.trim();
  const titleLength = title.length;
  const contentLength = content.length;
  const combinedLength = combined.length;
  const signalFlags = computeSignalFlags(combined);
  const signalCount = signalFlags.has_pricing_signal + signalFlags.has_usage_signal
    + signalFlags.has_quality_signal + signalFlags.has_feature_signal + signalFlags.has_issue_signal;
  const hasProductSignal = signalCount > 0 ? 1 : 0;
  const isLong = combinedLength >= args.longChars;
  const isSignal = combinedLength >= args.signalChars && hasProductSignal === 1;
  const floorReason = isLong ? 'long_review' : (isSignal ? 'signal_review' : null);
  const helpfulCount = row.helpful_count ?? 0;

  return {
    review_key: row.review_key,
    product_key: row.product_key,
    platform: row.platform,
    app_id: row.app_id,
    country: row.country,
    lang: row.lang,
    sort: row.sort,
    evaluated_at: evaluatedAt,
    rating: row.rating,
    helpful_count: helpfulCount,
    title_length: titleLength,
    content_length: contentLength,
    combined_length: combinedLength,
    word_count: countWords(combined),
    reviewed_at: row.reviewed_at,
    app_version: row.app_version,
    has_product_signal: hasProductSignal,
    ...signalFlags,
    signal_count: signalCount,
    floor_pass: floorReason ? 1 : 0,
    floor_reason: floorReason,
    analysis_value_score: analysisValueScore({
      combinedLength,
      helpfulCount,
      signalCount,
      rating: row.rating,
    }),
    passed: 0,
  };
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
  if (!args.product) { console.error(HELP); process.exit(1); }
  if (!['play', 'ios', 'both'].includes(args.platform)) {
    console.error('--platform must be one of play|ios|both'); process.exit(1);
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

  const dbPath = resolveDbPath(dataDir);
  const db = openDb(dbPath);
  const reviews = selectReviewsForEvaluate(db, product.canonical, args.platform);

  const evaluatedAt = new Date().toISOString();
  const records = reviews.map((row) => computeFeature(row, args, evaluatedAt));

  const candidates = records
    .filter((r) => r.floor_pass === 1)
    .sort((a, b) => {
      if (b.analysis_value_score !== a.analysis_value_score) return b.analysis_value_score - a.analysis_value_score;
      if (b.helpful_count !== a.helpful_count) return b.helpful_count - a.helpful_count;
      if (b.combined_length !== a.combined_length) return b.combined_length - a.combined_length;
      return a.review_key.localeCompare(b.review_key);
    });
  for (const c of candidates.slice(0, args.top)) c.passed = 1;

  clearFeaturesPassed(db, product.canonical, args.platform);
  for (const r of records) upsertFeature(db, r);

  console.error(
    `evaluate ${product.canonical} platform=${args.platform}\n`
    + `${records.length} reviews evaluated, ${records.filter((r) => r.floor_pass === 1).length} floor-passed, `
    + `${records.filter((r) => r.passed === 1).length} selected (top by score)`
  );

  const reviewByKey = new Map(reviews.map((r) => [r.review_key, r]));
  const output = records
    .filter((r) => r.passed === 1)
    .map((r) => {
      const src = reviewByKey.get(r.review_key);
      return {
        review_key: r.review_key,
        platform: r.platform,
        country: r.country,
        lang: r.lang,
        rating: r.rating,
        title: src.title,
        content: src.content,
        helpful_count: r.helpful_count,
        reviewed_at: r.reviewed_at,
        app_version: r.app_version,
        reply_content: src.reply_content,
        signals: signalNamesFromFlags(r),
        score: Number(r.analysis_value_score.toFixed(3)),
      };
    });

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main().catch((e) => {
  console.error(`fatal: ${e.stack || e.message}`);
  process.exit(1);
});
