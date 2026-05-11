# qly Data Model

All data lives in `.qlydata/qlydata.db` (SQLite, opened via `node:sqlite`). The schema is defined in `schema.sql` and applied idempotently each run.

## Tables

### sightings — products observed under a keyword

| Column | Type | Notes |
|---|---|---|
| `keyword` | TEXT | The search term used |
| `product_url` | TEXT | Stable product URL; used as business identifier |
| `observed_at` | TEXT | First time this (keyword, product_url) was seen |
| `updated_at` | TEXT | Latest time it was re-observed |
| `product_name` | TEXT | Product display name |
| `shop_name` | TEXT | Shop owner name (may be null) |
| `qly_detail_url` | TEXT | URL to qly's product detail page, contains `pId=<id>` |
| `raw_json` | TEXT | Entire xlsx row as JSON (preserves all qly fields incl. 退货率, sales trends, tags) |

PK: `(keyword, product_url)`. raw_json is a **latest-snapshot**: each scrape's UPSERT overwrites prior raw_json. Use `MIN(observed_at)` / `MAX(updated_at)` for temporal questions.

**pid extraction** (not a column, derived):
```sql
SUBSTR(qly_detail_url, INSTR(qly_detail_url, 'pId=') + 4) AS pid
```

### relevance_annotations — auto + human judgment per sighting

| Column | Type | Notes |
|---|---|---|
| `keyword`, `product_url` | TEXT | FK pair into `sightings` |
| `product_name`, `shop_name`, `image_url` | TEXT | Denormalized for export ergonomics |
| `decision_auto` | TEXT | `kept` / `dropped` — set by BGE score |
| `decision_human` | TEXT | `kept` / `dropped` / NULL — reviewer override, **never overwritten by score** |
| `score_v2` | REAL | cosine(positive_query, product_doc) |
| `score_neg` | REAL | cosine(negative_query, product_doc) |
| `score_v3` | REAL | `v2 - alpha * neg` — the actual decision driver |
| `keyword_flag` | TEXT | `low_signal` / `ok` — per-keyword informational flag (set when mean(v2) < stage1) |
| `human_note` | TEXT | Reviewer free text |
| `scored_at` | TEXT | Last scoring timestamp |

PK: `(keyword, product_url)`.

**Label model is two-dimensional**:
- `decision_auto` / `decision_human` are per-product
- `keyword_flag` is per-keyword (a flag the reviewer should pay attention to — products in low_signal keywords are most likely false positives)

### influencer_sightings — KOL × product

| Column | Type | Notes |
|---|---|---|
| `uid` | TEXT | Influencer UID from qly |
| `pid` | TEXT | Product ID (extracted from sightings.qly_detail_url) |
| `observed_at` | TEXT | First time we saw this uid selling this pid |
| `updated_at` | TEXT | Latest scrape confirmation |

PK: `(uid, pid)`. No `raw_json` here — qly's `/common/exist/live` XHR only leaks a uid list (no rich metadata); the rich `/goods/userList` response is AES-encrypted and out of scope.

### influencer_pid_runs — scrape history per pid

| Column | Type | Notes |
|---|---|---|
| `pid` | TEXT | Product ID |
| `filter` | TEXT | `time=N,type=live\|video` tag string |
| `scraped_at` | TEXT | When this run happened |
| `uid_count` | INTEGER | UIDs landed (0 is valid: "scraped, found nothing") |
| `status` | TEXT | `ok` / `failed` / `quota_hit` / `session_lost` |
| `reason` | TEXT | Failure message (truncated to 500 chars) |

PK: `(pid, filter, scraped_at)`.

**Why this exists separately from influencer_sightings**:
1. A 0-KOL pid has no `influencer_sightings` rows; without this table we can't tell "scraped + empty" from "never scraped"
2. `status` lets us implement `--retry <duration>` cleanly
3. Sole structured source for "what happened on day X" forensics
