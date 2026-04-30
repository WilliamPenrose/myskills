---
name: app-reviews
description: Use when analyzing user feedback for a mobile app — fetches reviews from Google Play and Apple App Store into a local SQLite store, filters them by rule-based heuristics, and emits the highest-signal subset as JSON for direct LLM analysis. Trigger phrases include "analyze app reviews", "what are users saying about <app>", "Play Store feedback", "App Store reviews".
---

# app-reviews

Fetch and filter mobile app store reviews so you can analyze them directly.

## What this skill does

Two scripts. They are tools, not analysis:

1. `fetch.mjs` — pulls reviews from Google Play or Apple App Store into a local SQLite DB
2. `evaluate.mjs` — drops junk (reviews with too little analyzable text), scores the rest by a language-neutral formula (substance + crowd-validation + rating + dev reply), and emits the top-N as JSON on stdout

The strategy is intentionally **language-agnostic** — no keyword regex, no per-language tuning. It works on English, CJK, RTL scripts, etc. uniformly. Topical categorization (pricing complaints vs. quality complaints vs. ...) is the LLM's job, not the script's.

Analysis itself is your job. Read the JSON, look for patterns, draw conclusions in the conversation. Do not call out to another LLM for this.

## Where data lives

Reviews and the product registry live in a project-local `.app-reviews/` directory:

- `products.json` — registry mapping canonical names to app IDs (user-curated)
- `reviews.db` — SQLite, auto-created on first fetch
- `.gitignore` — auto-written with `*` if the project is a git repo, so the dir is ignored

The data directory is resolved in this order:

1. `--data-dir <path>` CLI flag
2. `APP_REVIEWS_DATA_DIR` env var
3. The nearest existing `.app-reviews/` directory walking up from CWD
4. `<git_root>/.app-reviews/` if CWD is inside a git repo
5. `<CWD>/.app-reviews/` as a last resort

Run from a project root (or a subdirectory of one) and the data lands in that project. To share a registry across projects, set `APP_REVIEWS_DATA_DIR=~/.claude/data/app-reviews` (or anywhere else) in your shell profile.

The first time you run `fetch` or `evaluate`, if `products.json` does not exist, the script creates an empty template and exits 1 with a message. The user must populate it before the skill can do anything useful.

`products.json` format:

```json
{
  "tipsy": {
    "aliases": ["tt", "tipsyturbo"],
    "play": "com.tipsyturbo.app",
    "ios": "1234567890",
    "default_country": "us"
  }
}
```

- The top-level key is the **canonical name**. It is what the DB stores in `product_key`.
- `aliases` are alternate names. Lookup is case-insensitive. Aliases can be in any language since this file is private to the user.
- `play` and `ios` are the Google Play package name and Apple App Store numeric ID. Either may be omitted if the product is not on that platform.
- `default_country` is optional; defaults to `us`. There is intentionally no `default_lang`: Play requires `--lang` on every fetch (see Workflow), and iOS does not use a language parameter.

A reference `products.example.json` ships in this skill's directory.

## Workflow

When the user asks you to analyze app reviews:

1. **Resolve the colloquial name to a canonical product.** The fetch/evaluate scripts look up the name in `.app-reviews/products.json` (canonical key + aliases, case-insensitive). If it resolves, you're done — proceed to step 2.

   If the name does **not** resolve, do **not** ask the user for a Play package name or iOS numeric ID — most users don't know that mapping. **Research it yourself**, then confirm the right app with the user. Use your own tools (no extra script):

   - **iTunes search API via `WebFetch`** — clean JSON, the most reliable iOS source:
     ```
     https://itunes.apple.com/search?term=NAME&entity=software&country=us&limit=8
     ```
     Pull `trackName`, `sellerName`, `trackId` (the numeric `ios` ID), and `trackViewUrl` from each result. Vary `country=` if the user mentioned a non-US market.
   - **Google Play via `WebSearch`** — query `NAME site:play.google.com/store/apps` and read package IDs out of the result URLs (`?id=com.xxx.yyy`). For richer detail, `WebFetch` `https://play.google.com/store/apps/details?id=PACKAGE&hl=en&gl=us` to confirm app name and developer.

   Present the top 2–3 candidates per platform (name, developer, store URL) and ask the user **(a)** which app they meant and **(b)** which country/locale to analyze. Asking about market is fine; asking them to translate a colloquial name into a raw app ID is not.

   Once confirmed, append the entry to `.app-reviews/products.json` (canonical key, optional aliases, `play`, `ios`, `default_country`) before fetching. Edit the user's data file — never edit the skill's `products.example.json`.

   **Never invent app IDs from training data.** If the search returns nothing useful (truly obscure / unreleased app), then ask the user.

2. **Resolve `(country, hl)` for Play before fetching.** Google Play's reviews endpoint filters by `hl` (host language), not `gl`. **Omitting `hl` returns a global English fallback set with no error — silently wrong data.** The fetch script therefore requires `--lang` for `--platform play` and will refuse to run without it.

   Before calling fetch, derive `hl` from the target country yourself, using your general knowledge of which language is spoken there:

   - tw → `zh-TW`, hk → `zh-HK`, jp → `ja`, kr → `ko`
   - br → `pt-BR`, mx → `es-MX`, de → `de`, fr → `fr`, it → `it`
   - us / au / sg → `en`

   For multi-locale countries (CA, IN, CH, BE), ask the user which locale they want — do not pick a default. A wrong `hl` returns a misleading non-empty result, not an error.

   For `--platform ios`, pass only `--country`. Apple's reviews endpoint ignores any language parameter; the script rejects `--lang` for ios as a usage error.

   To check what data is already in the local DB for a given app+market before fetching, query `reviews.db` directly (e.g. `SELECT country, COUNT(*) FROM app_reviews WHERE product_key=? AND platform=? GROUP BY country`). There's no separate cache file — the DB is the source of truth.

3. **Fetch reviews.** Run one invocation per platform you want:
   ```
   node <skill_dir>/scripts/fetch.mjs --product <canonical> --platform play --country tw --lang zh-TW --limit 500
   node <skill_dir>/scripts/fetch.mjs --product <canonical> --platform ios  --country tw --limit 100
   ```
   Read stderr for progress (the first line prints the resolved data dir); stdout is silent on success.

   **iOS soft cap:** the iOS fetcher refuses `--limit > 100` unless `--force` is passed. Apple's reviews API is heavily rate-limited (page size capped at 20, IP-bucketed throttling); pulling more than ~100 in one country routinely triggers minutes of 429 backoffs and often still fails. Default to `--limit 100` for iOS — the most recent reviews are usually enough to surface the dominant complaints. If you genuinely need more (e.g. user explicitly asks for an exhaustive pull, or 100 isn't surfacing what you need), tell the user it'll be slow and add `--force`.

   **iOS stats line:** every iOS fetch prints an `ios stats:` line on stderr summarizing `requests` (HTTP calls made), `429s` (rate-limit hits during this run), `pacer` (cumulative wait imposed by the 1.5s minimum-interval throttle), `server` (cumulative response time from Apple), `backoff` (cumulative wait after 429s), `total` (wall time), and `avgServerMs`. If `429s > 0` or `backoff` is large, the run was throttled — wait longer between iOS fetches or try a different country next time. If `pacer` dominates `total`, the bottleneck is our internal throttle, not Apple.

4. **Evaluate and read the JSON.** Default to a 90-day time window for "what are users saying" / "user feedback" / "recent reviews" type asks:
   ```
   node <skill_dir>/scripts/evaluate.mjs --product <canonical> --days 90
   ```
   Stdout is a JSON array of high-signal reviews. Parse it and analyze.

   **When to override `--days 90`:**
   - User explicitly asks for historical / overall reception → omit `--days` (the score's recency decay still mildly favors recent ones, but old impactful reviews can compete)
   - User mentions a specific release date → use `--since YYYY-MM-DD` with that date
   - User wants very fresh signal ("this week", "the last update") → `--days 7` or `--days 30`
   - Low-volume product where 90 days yields too few reviews → widen the window or drop `--days`

   `--since` and `--days` are mutually exclusive.

`<skill_dir>` is the directory containing this SKILL.md.

## evaluate output

Reviews are first filtered by a junk floor (drops near-empty reviews like single emojis or one-word ratings — controlled by `--min-bytes`, default 15), then ranked by a language-neutral score that favors substantive text, helpful_count, negative ratings, dev replies, and recency. Top `--top` (default 200) are emitted. See `_lib/signals.mjs` for the exact formula.

`--since YYYY-MM-DD` is a hard cutoff applied before ranking — use it when you know a release date and only want feedback on the current build.

**JSON output schema** — each element of the array:

| Field | Type | Notes |
|---|---|---|
| `review_key` | string | Unique key `<platform>:<app_id>:<country>:<review_id>` |
| `platform` | `"play"` or `"ios"` | |
| `country` | string | Lowercase 2-letter code |
| `lang` | string | Lowercase. Set on Play rows (e.g. `zh-tw`); empty string on iOS rows, since Apple's endpoint does not filter by language. |
| `rating` | int 1-5 or null | |
| `title` | string or null | iOS reviews have titles; Play reviews don't |
| `content` | string or null | The body |
| `helpful_count` | int | Up-vote / thumbs-up count |
| `reviewed_at` | ISO 8601 string | |
| `app_version` | string or null | |
| `reply_content` | string or null | Developer's reply, if any (Play only) |
| `meaningful_bytes` | int | Substance metric used by floor and score |
| `score` | number | Sort key (descending). Formula above. |

Sort order in the array is descending by score. Bucketing by topic (pricing, quality, etc.) is your job once you read the JSON — the script does not pre-categorize.

## Adding a new alias

If the user refers to an *existing* product by a name not in the registry (e.g. they said "the drinking app" and you figured out they meant the already-registered `tipsy`), edit the active `.app-reviews/products.json` and append to the relevant `aliases` array. **Edit the user's data file — never edit the skill's `products.example.json`.**

For a *new* product the user has never registered, follow the lookup workflow in step 1 of the Workflow section instead — research the app IDs via WebFetch/WebSearch, confirm with the user, and add a fresh top-level entry.

## Error handling

| stderr signature | Meaning | Action |
|---|---|---|
| `created empty products.json at ...` | First-time setup | Tell the user to populate it; exit |
| `unknown product "X". Known products: ...` | Name didn't match | If it's a typo or alias of one of the listed products, add it as an alias. Otherwise it's a new product — run the lookup workflow (Workflow step 1) to research candidates and add an entry. |
| `product "X" has no <play\|ios> app id configured` | Platform not configured | Skip that platform or ask the user to add it |
| `Google Play rejected the reviews request with PlayGatewayError` | Google rate-limited or blocked | **Do not retry.** Report to the user; suggest waiting |
| `Apple App Store reviews request failed with HTTP <status>` | Apple endpoint returned non-2xx (rare outside 429) | Report to the user |
| `Apple App Store reviews request failed: 429 retries exhausted` | Apple rate-limited beyond the script's backoff budget | **Do not retry immediately.** Wait, or try a different country |

## When the upstream API drifts

Both Play and Apple endpoints are reverse-engineered. They occasionally change shape without notice.

If you see any of these, read `references/repairing-scrapers.md` before assuming a skill bug:

- A fetch error ending with `See references/repairing-scrapers.md`
- `health:` summary in fetch's stderr showing a key field at near-zero non-null count (e.g. `content=0/100` after a non-trivial fetch)
- evaluate output that looks structurally wrong (e.g. rating all null, content mostly empty)

You diagnose and propose a unified diff; you do not apply it. The user applies.

## What NOT to do

- **Do not invent app IDs or product names from training data.** Lookup is deterministic via products.json; if a name isn't there, research it via WebFetch/WebSearch on the public stores (see Workflow step 1) and confirm with the user before adding it. Don't dump the raw-ID lookup task on the user.
- **Do not pipe `fetch` stderr into analysis.** It's progress reporting, not data.
- **Do not re-run `evaluate` with different `--top` values to "get more".** Set `--top` once. The selection is deterministic given the inputs.
- **Do not analyze the raw `app_reviews` table directly.** Always go through `evaluate` so noise is filtered. (If you really need raw data for a specific deep-dive, fine, but the default path is evaluate-then-analyze.)
- **Do not auto-retry on `PlayGatewayError`.** Retries trigger more aggressive rate-limiting. Wait.
- **Do not commit `.app-reviews/` to any repo.** It's user-private state. The skill auto-writes a `.gitignore` inside the directory when it detects a git repo, but verify before committing.
