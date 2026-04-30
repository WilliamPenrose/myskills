#!/usr/bin/env node
import './_lib/silence-warnings.mjs';
import {
  resolveDbPath, openDb, selectReviewsForEvaluate,
  clearFeaturesPassed, upsertFeature,
} from './_lib/db.mjs';
import { resolveProduct, bootstrapIfMissing, getProductsPath, resolveDataDir } from './_lib/products.mjs';
import { meaningfulBytes, analysisValueScore } from './_lib/signals.mjs';

const HELP = `
evaluate --product <name> [options]

Required:
  --product <name>      product canonical name or alias

Optional:
  --platform <play|ios|both>   default: both
  --top <n>                    selection limit, default: 200
  --min-bytes <n>              floor: minimum meaningful UTF-8 bytes
                               (letters only, after stripping non-letter chars).
                               default: 15
  --since <YYYY-MM-DD>         drop reviews dated before this. useful when
                               only feedback after a release matters.
  --days <n>                   drop reviews older than n days. shorthand for
                               --since (today - n days). mutually exclusive
                               with --since.
  --data-dir <path>            override data directory (default: project-local .app-reviews/)
`.trim();

function parseArgs(argv) {
  const args = { platform: 'both', top: 200, minBytes: 15 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { args.help = true; continue; }
    if (a === '--product')    { args.product = argv[++i]; continue; }
    if (a === '--platform')   { args.platform = argv[++i]; continue; }
    if (a === '--top')        { args.top = parseInt(argv[++i], 10); continue; }
    if (a === '--min-bytes')  { args.minBytes = parseInt(argv[++i], 10); continue; }
    if (a === '--since')      { args.since = argv[++i]; continue; }
    if (a === '--days')       { args.days = parseInt(argv[++i], 10); continue; }
    if (a === '--data-dir')   { args.dataDir = argv[++i]; continue; }
    throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function ageDaysFrom(reviewedAt, nowMs) {
  if (!reviewedAt) return null;
  const t = Date.parse(reviewedAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (nowMs - t) / 86400000);
}

function computeFeature(row, args, evaluatedAt, nowMs) {
  const title = (row.title ?? '').trim();
  const content = (row.content ?? '').trim();
  const combined = `${title}\n${content}`.trim();
  const mb = meaningfulBytes(combined);
  const helpfulCount = row.helpful_count ?? 0;
  const hasReply = row.reply_content && row.reply_content.trim().length > 0 ? 1 : 0;
  const floorPass = mb >= args.minBytes ? 1 : 0;
  const ageDays = ageDaysFrom(row.reviewed_at, nowMs);

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
    meaningful_bytes: mb,
    reviewed_at: row.reviewed_at,
    app_version: row.app_version,
    has_reply: hasReply,
    floor_pass: floorPass,
    analysis_value_score: analysisValueScore({
      meaningfulBytes: mb,
      helpfulCount,
      rating: row.rating,
      hasReply: hasReply === 1,
      ageDays,
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
  if (!Number.isInteger(args.minBytes) || args.minBytes < 0) {
    console.error('--min-bytes must be a non-negative integer'); process.exit(1);
  }
  if (!Number.isInteger(args.top) || args.top < 1) {
    console.error('--top must be a positive integer'); process.exit(1);
  }
  if (args.since != null && args.days != null) {
    console.error('--since and --days are mutually exclusive'); process.exit(1);
  }
  let sinceMs = null;
  let sinceLabel = null;
  if (args.since != null) {
    const t = Date.parse(args.since);
    if (!Number.isFinite(t)) {
      console.error(`--since must be a valid date (YYYY-MM-DD). got: ${args.since}`); process.exit(1);
    }
    sinceMs = t;
    sinceLabel = args.since;
  } else if (args.days != null) {
    if (!Number.isInteger(args.days) || args.days < 1) {
      console.error('--days must be a positive integer'); process.exit(1);
    }
    sinceMs = Date.now() - args.days * 86400000;
    sinceLabel = `last ${args.days}d`;
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

  const nowMs = Date.now();
  const evaluatedAt = new Date(nowMs).toISOString();
  const records = reviews.map((row) => computeFeature(row, args, evaluatedAt, nowMs));

  // Floor (junk gate): drop anything with too little analyzable content.
  // Recency cutoff (--since): drop anything older than the requested date.
  // Score (ranking): rank the rest by analysis_value_score; cap at --top.
  const candidates = records
    .filter((r) => r.floor_pass === 1)
    .filter((r) => {
      if (sinceMs == null) return true;
      if (!r.reviewed_at) return false;  // unknown date is treated as too old
      return Date.parse(r.reviewed_at) >= sinceMs;
    })
    .sort((a, b) => {
      if (b.analysis_value_score !== a.analysis_value_score) return b.analysis_value_score - a.analysis_value_score;
      if (b.helpful_count !== a.helpful_count) return b.helpful_count - a.helpful_count;
      if (b.meaningful_bytes !== a.meaningful_bytes) return b.meaningful_bytes - a.meaningful_bytes;
      return a.review_key.localeCompare(b.review_key);
    });
  for (const c of candidates.slice(0, args.top)) c.passed = 1;

  clearFeaturesPassed(db, product.canonical, args.platform);
  for (const r of records) upsertFeature(db, r);

  const sinceNote = sinceMs == null ? '' : `, since=${sinceLabel} cutoff dropped ${records.filter((r) => r.floor_pass === 1).length - candidates.length} pre-cutoff`;
  console.error(
    `evaluate ${product.canonical} platform=${args.platform}\n`
    + `${records.length} reviews evaluated, ${records.filter((r) => r.floor_pass === 1).length} floor-passed${sinceNote}, `
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
        meaningful_bytes: r.meaningful_bytes,
        score: Number(r.analysis_value_score.toFixed(3)),
      };
    });

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main().catch((e) => {
  console.error(`fatal: ${e.stack || e.message}`);
  process.exit(1);
});
