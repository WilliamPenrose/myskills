---
name: qly
description: Use when working with qlydata.com (千里眼 / 抖音电商分析后台) — drives a logged-in qlydata browser session to harvest products by keyword, score relevance with a local Chinese embedding model, and trace the influencers (KOL / 带货达人) selling each kept product. Trigger phrases include "qly", "qlydata", "千里眼", "抓商品", "KOL 带货达人".
---

# qly

Drive qlydata.com to harvest products, score relevance against a local Chinese embedding model, then trace the KOLs selling each kept product. Pipeline: **products → relevance → influencer**.

## Prerequisites

- `npm install` already ran in this skill directory (deps: `@site-use/runtime ^0.1.1`, `@xenova/transformers`, `exceljs`, `js-yaml`, `undici`)
- First-time only: user has logged into qlydata.com with their own account credentials in a site-use chrome instance. Cookies persist in the chrome profile; subsequent runs auto-launch chrome and reuse the session.
- `QLY_DATA_DIR` or a discoverable `.qlydata/` directory (see below)

## How chrome is managed

Scripts call `ensureBrowser({ autoLaunch: true })` (via `@site-use/runtime`). Chrome is started if not running and a tab is opened to qlydata's goods_search page if one isn't already there. If the session has expired, `_lib/session.mjs` will detect it (4-signal heuristic) and exit with a message telling the user to re-login in the chrome window.

## Where data lives

The skill resolves `.qlydata/` in this order:

1. `--data-dir <path>` CLI flag
2. `QLY_DATA_DIR` env var
3. Nearest existing `.qlydata/` walking up from cwd
4. `<git_root>/.qlydata/` if cwd is in a git repo
5. `<cwd>/.qlydata/` as final fallback

Contents:

```
.qlydata/
├── config.yaml        — filters, influencer thresholds, keywords_source.path
├── relevance.yaml     — BGE thresholds, positive/negative_default, per_keyword overrides
├── qlydata.db         — SQLite (schema in schema.sql)
├── exports/           — products xlsx (raw qly export, also serves as resume gate)
├── tasks/             — reviewer xlsx (relevance export) + tracking xlsx (influencer plan)
│   └── done/          — archived after `relevance import`
├── snapshots/         — debug DOM dumps (optional)
└── .logs/             — stderr per script
```

The keyword business xlsx/csv lives **outside** `.qlydata/`. The skill reads it via `config.yaml.keywords_source.path`. Required columns: `key_word` (search term) and `is_track` (1 = track, 0 = pause). Other columns are ignored.

## First-run onboarding

Before running any qly command, check whether `.qlydata/config.yaml` exists:

- **Missing** → enter full first-run onboarding. Follow the dialogue script in `references/onboarding.md` exactly. Do not skip steps and do not paraphrase the structure — the analyst-facing experience depends on consistency. Dialogue is delivered to the user in Chinese; the reference is in English.
- **Exists, but DB has no `sightings` rows** → light onboarding (skip Q1–Q4, jump to "first run plan" in `references/onboarding.md`).
- **Exists with data** → no onboarding; proceed with the workflow below.

The scripts themselves still exit with `CONFIG_MISSING` if invoked directly when configs are absent — onboarding only triggers when the user enters the skill, not on raw `node scripts/*.mjs` invocations.

## Workflow (weekly)

```
① products                                                 # drive qly + UPSERT sightings
② relevance score                                          # auto-label kept/dropped + low_signal flag
③ relevance export → reviewer xlsx                         # reviewer edits the decision column in Excel
   relevance import --in .qlydata/tasks/YYYY-MM-DD-v1.xlsx # apply review back to DB
④ influencer plan → tracking-{date}.xlsx                   # reviewer can override the conclusion column
⑤ influencer fetch --from-xlsx .qlydata/tasks/tracking-YYYY-MM-DD.xlsx
```

Each step is resumable: quota hit / session lost → exit 1 cleanly, re-run same command tomorrow.

CLI reference:

```bash
node scripts/check-keywords.mjs <path>                        # validate a keyword xlsx/csv, print JSON summary
node scripts/products.mjs                                     # everything in keywords_source where is_track=1
node scripts/products.mjs --keywords-xlsx <path>              # temp source override
node scripts/products.mjs --keywords <keyword>                # ad-hoc single keyword (bypass xlsx)
node scripts/products.mjs --rescrape <keyword>                # delete prior exports for keyword, re-scrape

node scripts/relevance.mjs score [--keyword <k>]
node scripts/relevance.mjs export [--filter pending|low_signal_kept|borderline|dropped|all] [--days N]
node scripts/relevance.mjs import --in <xlsx> [--dry-run]
node scripts/relevance.mjs audit                              # keyword x stage summary

node scripts/influencer.mjs plan [--min-gmv N]
node scripts/influencer.mjs fetch --from-xlsx <tracking.xlsx> [--time 7] [--type live] [--window-days 7] [--retry 1h] [--force] [--limit N] [--dry-run]
node scripts/influencer.mjs fetch --pids <csv>
```

## Daily quota and recovery

qly's brand-version cap is ~920 requests/day. When qly's daily-limit banner appears, scripts exit 1 with `QUOTA HIT` in the log. Resume next day by re-running the same command:

- `products` skips keywords with any prior xlsx in `exports/` (filename-match, not date-aware). To re-scrape a keyword, delete its xlsx or use `--rescrape`.
- `influencer fetch` skips pids whose last `ok` run is within `--window-days`. Failed pids are skipped unless you pass `--retry <duration>` (e.g. `--retry 1h`).

## Relevance: label model

Two independent dimensions:
- `decision_auto ∈ {kept, dropped}` — per product, set by `v3 < stage2_threshold` where `v3 = v2 - alpha * neg`
- `keyword_flag ∈ {low_signal, ok}` — per keyword, set by `mean(v2) < stage1_threshold` over that keyword's products

Reviewer focus order: filter `low_signal_kept` first (most likely false positives), then `borderline` (`v3 < 0.40` but `decision_auto=kept`).

## Reviewer xlsx style

For non-tech reviewers:

- Font: Microsoft YaHei 11pt
- AutoFilter on all columns
- Freeze: header row + first 4 columns
- Editable column (decision column for relevance, conclusion column for tracking): red bold (`#C00000`)
- Sort: `score_v3` ascending (riskiest at top)

## Tag tuning

When `relevance score` flags a keyword as `low_signal`, or when `audit` shows persistent over-drop:

1. Run `relevance audit` to see the keyword's `v2_mean` / `v3_min` / `n_dropped`
2. Browse the keyword's products: `sqlite3 .qlydata/qlydata.db "SELECT product_name FROM sightings WHERE keyword='X' LIMIT 20"`
3. Identify confusing homonyms (where the search term overlaps with a popular unrelated product name) and add to `relevance.yaml.per_keyword.X.negative_extra`
4. Re-run `relevance score --keyword X` to verify

No separate "sanity check" tool ships with the skill — query the DB directly and eyeball.

## What NOT to do

- Don't re-scrape pids within the gating window (don't `--force` to bypass)
- Don't retry a `quota_hit` failure immediately — wait until next day
- Don't read `sightings` directly when deciding "should we chase this product" — always go through `relevance_annotations.decision_effective = COALESCE(decision_human, decision_auto)`
- Don't treat `sightings.raw_json` as time-series data — it's a latest-snapshot, overwritten on each UPSERT

## Inspecting the live qly page

When you need to see what's actually on the page (UI drift, surprise
dialog, captcha state, hunting for a renamed selector) use:

```bash
node scripts/probe.mjs                          # dump active qly tab's snapshot + summary
node scripts/probe.mjs --url <url>              # navigate first
node scripts/probe.mjs --name <slug>            # control output filename
node scripts/probe.mjs --screenshot             # also save PNG
```

Read-only: does not click, type, or assert session. Outputs JSON
summary to stdout (`url`, `title`, `nodeCount`, hit list of known
signals like `dialog` / `captcha_title` / `quota_banner`) and a full
AX snapshot to `.qlydata/snapshots/<slug>-<timestamp>.json`. Use this
before writing a new selector — don't grep blindly.

## When qly's UI drifts

See `references/repairing-scrapers.md` for the diagnosis workflow.

## Data model details

See `references/data-model.md` for full schema + column semantics.
