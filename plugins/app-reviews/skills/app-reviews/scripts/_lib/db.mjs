import * as fs from 'node:fs';
import * as path from 'node:path';
const { DatabaseSync } = await import('node:sqlite');

const APP_REVIEWS_SCHEMA = `
CREATE TABLE IF NOT EXISTS app_reviews (
  review_key TEXT PRIMARY KEY,
  product_key TEXT NOT NULL,
  platform TEXT NOT NULL,
  app_id TEXT NOT NULL,
  country TEXT NOT NULL,
  lang TEXT NOT NULL,
  sort TEXT NOT NULL,
  review_id TEXT NOT NULL,
  user_name TEXT,
  user_url TEXT,
  user_image TEXT,
  rating INTEGER,
  title TEXT,
  content TEXT,
  helpful_count INTEGER,
  helpful_total INTEGER,
  review_created_version TEXT,
  app_version TEXT,
  reviewed_at TEXT,
  reply_content TEXT,
  replied_at TEXT,
  first_seen_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_app_reviews_product_platform
  ON app_reviews(product_key, platform);
CREATE INDEX IF NOT EXISTS idx_app_reviews_app_region
  ON app_reviews(platform, app_id, country, lang);
CREATE INDEX IF NOT EXISTS idx_app_reviews_reviewed_at
  ON app_reviews(reviewed_at);
CREATE INDEX IF NOT EXISTS idx_app_reviews_rating
  ON app_reviews(rating);
`;

const APP_REVIEW_FEATURES_SCHEMA = `
CREATE TABLE IF NOT EXISTS app_review_features (
  review_key TEXT PRIMARY KEY,
  product_key TEXT NOT NULL,
  platform TEXT NOT NULL,
  app_id TEXT NOT NULL,
  country TEXT NOT NULL,
  lang TEXT NOT NULL,
  sort TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  rating INTEGER,
  helpful_count INTEGER NOT NULL,
  meaningful_bytes INTEGER NOT NULL,
  reviewed_at TEXT,
  app_version TEXT,
  has_reply INTEGER NOT NULL,
  floor_pass INTEGER NOT NULL,
  analysis_value_score REAL NOT NULL,
  passed INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_app_review_features_product_passed
  ON app_review_features(product_key, platform, passed, analysis_value_score);
`;

// Bumped when the features-table columns change incompatibly. The features
// table is fully derived from app_reviews, so the migration just drops it
// and lets the next evaluate run repopulate it.
const FEATURES_SCHEMA_VERSION = 2;

export function resolveDbPath(dataDir) {
  if (process.env.APP_REVIEWS_DB) return path.resolve(process.env.APP_REVIEWS_DB);
  return path.join(dataDir, 'reviews.db');
}

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec(APP_REVIEWS_SCHEMA);

  const userVer = db.prepare('PRAGMA user_version').get().user_version ?? 0;
  if (userVer < FEATURES_SCHEMA_VERSION) {
    db.exec('DROP TABLE IF EXISTS app_review_features');
    db.exec(`PRAGMA user_version = ${FEATURES_SCHEMA_VERSION}`);
  }
  db.exec(APP_REVIEW_FEATURES_SCHEMA);
  return db;
}

export function appReviewKey({ platform, app_id, country, review_id }) {
  return `${platform}:${app_id}:${country}:${review_id}`;
}

export function countReviews(db, productKey, platform) {
  if (platform) {
    const row = db.prepare('SELECT COUNT(*) AS c FROM app_reviews WHERE product_key = ? AND platform = ?').get(productKey, platform);
    return Number(row.c);
  }
  const row = db.prepare('SELECT COUNT(*) AS c FROM app_reviews WHERE product_key = ?').get(productKey);
  return Number(row.c);
}

const REVIEW_COLUMNS = [
  'review_key', 'product_key', 'platform', 'app_id', 'country', 'lang', 'sort',
  'review_id', 'user_name', 'user_url', 'user_image', 'rating', 'title', 'content',
  'helpful_count', 'helpful_total', 'review_created_version', 'app_version',
  'reviewed_at', 'reply_content', 'replied_at', 'first_seen_at', 'fetched_at', 'raw_json',
];

export function upsertReview(db, row) {
  const placeholders = REVIEW_COLUMNS.map(() => '?').join(', ');
  const updates = REVIEW_COLUMNS
    .filter((c) => c !== 'review_key' && c !== 'first_seen_at')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  const sql = `
    INSERT INTO app_reviews (${REVIEW_COLUMNS.join(', ')})
    VALUES (${placeholders})
    ON CONFLICT(review_key) DO UPDATE SET ${updates}
  `;
  db.prepare(sql).run(...REVIEW_COLUMNS.map((c) => row[c]));
}

const FEATURE_COLUMNS = [
  'review_key', 'product_key', 'platform', 'app_id', 'country', 'lang', 'sort',
  'evaluated_at', 'rating', 'helpful_count', 'meaningful_bytes',
  'reviewed_at', 'app_version', 'has_reply',
  'floor_pass', 'analysis_value_score', 'passed',
];

export function clearFeaturesPassed(db, productKey, platform) {
  if (platform === 'both') {
    db.prepare('UPDATE app_review_features SET passed = 0 WHERE product_key = ?').run(productKey);
  } else {
    db.prepare('UPDATE app_review_features SET passed = 0 WHERE product_key = ? AND platform = ?').run(productKey, platform);
  }
}

export function upsertFeature(db, row) {
  const placeholders = FEATURE_COLUMNS.map(() => '?').join(', ');
  const updates = FEATURE_COLUMNS
    .filter((c) => c !== 'review_key')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  const sql = `
    INSERT INTO app_review_features (${FEATURE_COLUMNS.join(', ')})
    VALUES (${placeholders})
    ON CONFLICT(review_key) DO UPDATE SET ${updates}
  `;
  db.prepare(sql).run(...FEATURE_COLUMNS.map((c) => row[c]));
}

export function selectReviewsForEvaluate(db, productKey, platform) {
  if (platform === 'both') {
    return db.prepare(`
      SELECT review_key, product_key, platform, app_id, country, lang, sort,
             rating, title, content, helpful_count, reviewed_at, app_version, reply_content
      FROM app_reviews WHERE product_key = ?
    `).all(productKey);
  }
  return db.prepare(`
    SELECT review_key, product_key, platform, app_id, country, lang, sort,
           rating, title, content, helpful_count, reviewed_at, app_version, reply_content
    FROM app_reviews WHERE product_key = ? AND platform = ?
  `).all(productKey, platform);
}
