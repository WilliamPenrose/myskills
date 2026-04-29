---
name: app-reviews
description: Use when analyzing user feedback for a mobile app — fetches reviews from Google Play and Apple App Store into a local SQLite store, filters them by rule-based heuristics, and emits the highest-signal subset as JSON for direct LLM analysis. Trigger phrases include "analyze app reviews", "what are users saying about <app>", "Play Store feedback", "App Store reviews".
---

# app-reviews

Fetch and filter mobile app store reviews so you can analyze them directly.

## What this skill does

Two scripts. They are tools, not analysis:

1. `fetch.mjs` — pulls reviews from Google Play or Apple App Store into a local SQLite DB
2. `evaluate.mjs` — applies rule-based filters (length + 5 keyword signal groups + a scoring formula) and emits the top-N highest-signal reviews as JSON on stdout

Analysis itself is your job. Read the JSON, look for patterns, draw conclusions in the conversation. Do not call out to another LLM for this.

## Installation

This skill depends on the `undici` npm package for proxy support (so the scripts honor `HTTPS_PROXY` / `HTTP_PROXY` env vars). After cloning or copying the skill, run once:

```
cd <skill_dir> && npm install --omit=dev
```

Skip this only if you are sure no HTTP/HTTPS proxy is needed in your environment — the import will fail otherwise.

## First-time setup

Reviews and product registry live in `~/.claude/data/app-reviews/`:

- `products.json` — registry mapping canonical names to app IDs
- `reviews.db` — SQLite, auto-created on first fetch

The first time you run `fetch` or `evaluate`, if `products.json` does not exist, the script creates an empty template and exits 1 with a message. The user must populate it before the skill can do anything useful.

`products.json` format:

```json
{
  "tipsy": {
    "aliases": ["tt", "tipsyturbo"],
    "play": "com.tipsyturbo.app",
    "ios": "1234567890",
    "default_country": "us",
    "default_lang": "en"
  }
}
```

- The top-level key is the **canonical name**. It is what the DB stores in `product_key`.
- `aliases` are alternate names. Lookup is case-insensitive. Aliases can be in any language since this file is private to the user.
- `play` and `ios` are the Google Play package name and Apple App Store numeric ID. Either may be omitted if the product is not on that platform.
- `default_country` and `default_lang` are optional; default to `us` / `en`.

A reference `products.example.json` ships in this skill's directory.

## Workflow

When the user asks you to analyze app reviews:

1. **Resolve the colloquial name to a canonical product.** Read `~/.claude/data/app-reviews/products.json`. Find the product whose canonical name or aliases match what the user said. **Never invent app IDs.** If no match, ask the user; do not guess.

2. **Fetch reviews.** Run one invocation per platform you want:
   ```
   node <skill_dir>/scripts/fetch.mjs --product <canonical> --platform play --limit 1000
   node <skill_dir>/scripts/fetch.mjs --product <canonical> --platform ios --limit 500
   ```
   Read stderr for progress; stdout is silent on success.

3. **Evaluate and read the JSON.** Run:
   ```
   node <skill_dir>/scripts/evaluate.mjs --product <canonical>
   ```
   Stdout is a JSON array of high-signal reviews. Parse it and analyze.

`<skill_dir>` is the directory containing this SKILL.md. While developing inside x-growth, that's `.claude/skills/app-reviews`. Once promoted, it's `~/.claude/skills/app-reviews`.

## evaluate JSON output schema

Each element of the array:

| Field | Type | Notes |
|---|---|---|
| `review_key` | string | Unique key `<platform>:<app_id>:<country>:<review_id>` |
| `platform` | `"play"` or `"ios"` | |
| `country` | string | Lowercase 2-letter code |
| `lang` | string | Lowercase, only meaningful for Play |
| `rating` | int 1-5 or null | |
| `title` | string or null | iOS reviews have titles; Play reviews don't |
| `content` | string or null | The body |
| `helpful_count` | int | Up-vote / thumbs-up count |
| `reviewed_at` | ISO 8601 string | |
| `app_version` | string or null | |
| `reply_content` | string or null | Developer's reply, if any (Play only) |
| `signals` | array of strings | Subset of `["pricing", "usage", "quality", "feature", "issue"]` matched by keyword regex |
| `score` | number | Higher = denser signal. Formula: `log(1+combined_length) + 0.5*log(1+helpful) + signal_count + (rating<=3 ? 0.5 : 0)` |

Use `signals` to bucket complaints by topic. Use `score` to prioritize when there are too many to read. Sort order in the array is descending by score.

## Adding a new alias

If the user refers to an existing product by a name not in the registry (e.g. they said "the drinking app" and you figured out they meant `tipsy`), edit `~/.claude/data/app-reviews/products.json` and append to the relevant `aliases` array. **Edit the user's data file — never edit the skill's `products.example.json`.**

## Error handling

| stderr signature | Meaning | Action |
|---|---|---|
| `created empty products.json at ...` | First-time setup | Tell the user to populate it; exit |
| `unknown product "X". Known products: ...` | Name didn't match | Pick from the listed products, or ask the user |
| `product "X" has no <play\|ios> app id configured` | Platform not configured | Skip that platform or ask the user to add it |
| `Google Play rejected the reviews request with PlayGatewayError` | Google rate-limited or blocked | **Do not retry.** Report to the user; suggest waiting |
| `Apple App Store reviews request failed with HTTP <status>` | Apple RSS error | Report to the user; rare |
| `note: Apple RSS feed caps reviews at ~500 per country` | Just informational | Ignore; iOS limit is hard |
| iOS fetch reports `0 fetched` | Apple's RSS customerreviews feed has been progressively deprecated and frequently returns empty feeds for many apps and countries — even popular ones. **This is not a bug in the skill.** Try a different country, or accept that iOS reviews may not be retrievable for this app/region right now. | Tell the user; do not retry |

## What NOT to do

- **Do not invent app IDs or product names.** Lookup is deterministic via products.json. If a name isn't there, ask the user.
- **Do not pipe `fetch` stderr into analysis.** It's progress reporting, not data.
- **Do not re-run `evaluate` with different `--top` values to "get more".** Set `--top` once. The selection is deterministic given the inputs.
- **Do not analyze the raw `app_reviews` table directly.** Always go through `evaluate` so noise is filtered. (If you really need raw data for a specific deep-dive, fine, but the default path is evaluate-then-analyze.)
- **Do not auto-retry on `PlayGatewayError`.** Retries trigger more aggressive rate-limiting. Wait.
- **Do not commit `~/.claude/data/app-reviews/` to any repo.** It's user-private state.
