-- @site-use/qly schema. Compatible with existing .dev/docs/qlydata/qlydata.db.
-- All tables use IF NOT EXISTS so re-running on an existing db is a no-op.

CREATE TABLE IF NOT EXISTS sightings (
  keyword         TEXT NOT NULL,
  product_url     TEXT NOT NULL,
  observed_at     TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  product_name    TEXT NOT NULL,
  shop_name       TEXT,
  qly_detail_url  TEXT,
  raw_json        TEXT,
  PRIMARY KEY (keyword, product_url)
);
CREATE INDEX IF NOT EXISTS idx_sightings_updated_at ON sightings(updated_at);

CREATE TABLE IF NOT EXISTS relevance_annotations (
  keyword         TEXT NOT NULL,
  product_url     TEXT NOT NULL,
  product_name    TEXT NOT NULL,
  shop_name       TEXT,
  image_url       TEXT,
  decision_auto   TEXT NOT NULL,
  decision_human  TEXT,
  score_v2        REAL NOT NULL,
  score_neg       REAL NOT NULL,
  score_v3        REAL NOT NULL,
  keyword_flag    TEXT,
  human_note      TEXT,
  scored_at       TEXT NOT NULL,
  PRIMARY KEY (keyword, product_url)
);

CREATE TABLE IF NOT EXISTS influencer_sightings (
  uid             TEXT NOT NULL,
  pid             TEXT NOT NULL,
  observed_at     TEXT NOT NULL DEFAULT '',
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (uid, pid)
);
CREATE INDEX IF NOT EXISTS idx_inf_pid      ON influencer_sightings(pid);
CREATE INDEX IF NOT EXISTS idx_inf_updated  ON influencer_sightings(updated_at);

CREATE TABLE IF NOT EXISTS influencer_pid_runs (
  pid             TEXT NOT NULL,
  filter          TEXT NOT NULL,
  scraped_at      TEXT NOT NULL,
  uid_count       INTEGER NOT NULL,
  status          TEXT NOT NULL,
  reason          TEXT,
  PRIMARY KEY (pid, filter, scraped_at)
);
CREATE INDEX IF NOT EXISTS idx_pidruns_lookup ON influencer_pid_runs(pid, filter, scraped_at);
