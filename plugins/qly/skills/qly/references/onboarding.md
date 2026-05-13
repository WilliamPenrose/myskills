# qly first-run onboarding

This document is loaded by `SKILL.md` when a user invokes the qly skill and
no `.qlydata/config.yaml` exists. Claude follows the steps below in order.

**Language note.** This skill is used by Chinese-speaking analysts. All
dialogue with the user must be in Chinese, even though the instructions in
this file are written in English. Adapt phrasing naturally to context, but
do not skip steps or drop information items.

## Detection

Before running any qly command, check `.qlydata/config.yaml`:

- File missing → **full onboarding** (steps 1–7 below)
- File exists, but `qlydata.db` has zero rows in `sightings` → **light
  onboarding** (skip to step 7; frame as "configs are already set, ready
  for the first fetch")
- File exists + `sightings` has rows → **no onboarding**, proceed to the
  normal workflow described in `SKILL.md`

## Step 1 — welcome and overview

Tell the user, in a single Chinese paragraph:

1. This appears to be their first time using qly. You'll spend about two
   minutes on setup before any data is fetched.
2. What this tool does: it drives a logged-in qlydata.com browser session
   to (a) pull product lists for each keyword they monitor, (b) auto-score
   the products with a local Chinese embedding model and surface borderline
   ones for a human reviewer, (c) for each kept product, look up which
   influencer accounts livestream-sold it in the past week.
3. The pipeline has three commands. They run **on demand** — the user (or
   Claude on the user's behalf) invokes each one. There is **no background
   scheduler**. "Weekly" is just the recommended cadence.
4. Final deliverable: per monitored product, the past 7 days of sales
   figures plus the list of influencer UIDs who livestream-sold it in
   that window.
5. Before fetching anything you will ask 3 short questions.

## Step 2 — prerequisite note: qlydata login

Tell the user (no action required at this step, just expectation-setting):

- On the first `products` run, a chrome window will open at qlydata.com.
- They must log in with their own qly account credentials (username +
  password) in that window. Cookies persist in the chrome profile;
  subsequent runs reuse the session automatically.
- If the session expires later, scripts exit cleanly with a message
  telling them to re-login in the chrome window.

Do **not** launch chrome at this step. Login happens naturally when the
first products run starts.

## Step 3 — Q1: keyword list file (free-form input)

Ask the user, in Chinese, for the absolute path to their keyword xlsx or
csv file.

Explain in the same message:

- The file is maintained by the business side, not by this tool.
- Required columns:
  - `key_word` (text) — the search term to query in qly
  - `is_track` (1 or 0) — 1 = scrape this week, 0 = pause (kept in
    history, just not fetched on this run)
- Other columns (id, owner, notes, etc.) are ignored.

Validate the file by running, from the skill directory:

```
node scripts/check-keywords.mjs <path>
```

This is the single source of truth for keyword-file validation — the
same logic that `products.mjs` uses at scrape time. Do NOT re-implement
the parsing in ad-hoc inline code.

On exit 0, the script prints a JSON summary on stdout:

```json
{
  "total": 101,
  "active": 20,
  "activeSample": ["...", "...", "...", "...", "..."],
  "columns": ["id", "key_word", "is_track", "..."]
}
```

Show the user `total`, `active`, and `activeSample` in a short Chinese
summary, then ask "看起来对吗?" If they say no, abort and let them
re-provide.

On non-zero exit, the script writes a clear message to stderr:

- "File not found: ..." → ask the user to recheck the path.
- "unsupported keyword source format: ..." → file must be .xlsx or .csv.
- "missing required column ..." → message also lists the columns that
  ARE present; ask the user to rename or supply a different file.
- "Cannot find module 'exceljs'" or similar → skill dependencies are
  not installed; run `npm install` in the skill directory and retry.

Forward the stderr message to the user verbatim (translated to Chinese
context as needed) and re-ask for a path.

## Step 4 — Q2: product filter ranges (AskUserQuestion)

Ask via `AskUserQuestion` with three options:

1. "Use defaults" — price 5–500 CNY, livestream sales 1–100000 units.
   Mark as "(Recommended)".
2. "Change price range"
3. "Change livestream sales range"

If they pick a "change" option, follow up with free-form input asking for
the new `min` and `max`.

## Step 5 — Q3: influencer thresholds (AskUserQuestion)

Ask via `AskUserQuestion` with two options:

1. "Use defaults" — `min_gmv = 1` (10k CNY), window 7 days.
   Mark as "(Recommended)".
2. "Customize"

For "customize", ask for `min_gmv` (numeric, in units of 10k CNY) and
`window_days` (integer).

## Step 6 — write the config files

1. Create `.qlydata/` if it does not exist.
2. Write `.qlydata/config.yaml` from the answers to Q1, Q2, Q3.
3. Copy `relevance.example.yaml` to `.qlydata/relevance.yaml` unchanged
   (empty `positive_default` / `negative_default`, default thresholds).
   Tag tuning is NOT part of onboarding — it is a debugging technique
   applied later, only when the first round of scoring produces
   noticeable false positives or false negatives for a specific
   keyword. See the "Relevance debugging techniques" note below.
4. Tell the user the absolute paths of both files and that they can
   edit them anytime by hand.

## Step 7 — first run plan

Compute a quota estimate:

- `N` = number of `is_track = 1` keywords
- Each keyword costs roughly 9 qly requests (search page + pagination
  + export trigger)
- qly's brand-version daily cap is approximately 920 requests

State to the user:

- Estimated requests for this run: `~N * 9`
- Whether one day's quota is enough, or the run will span multiple days
- The run is resumable. If quota hits mid-way, re-running the same
  command the next day picks up where it left off (keywords with a
  prior export xlsx are skipped).

Then offer via `AskUserQuestion`:

1. "Start the first products run now" — will open chrome; if not yet
   logged in, the user must enter their qly account credentials first.
2. "Hold off — I'll review the config first"

If they pick option 1, execute `node scripts/products.mjs` from the
skill directory. When it finishes (or hits quota), continue onboarding
by offering the next step in the pipeline:

- After products → "Products done. Run `relevance score` now to
  auto-label?"
- After score → "Scoring done. Export the borderline cases to xlsx
  for human review?"
- After export → pause. Tell the user the xlsx path and that they
  (or another reviewer) need to edit the decision column in Excel,
  then come back and ask Claude to import.
- After import → "Review imported. Generate the influencer tracking
  plan?"
- After plan → pause again. The tracking xlsx may need reviewer
  override of the conclusion column before fetch.
- After fetch → done. Tell the user the data is in
  `influencer_sightings`. Mention that a per-week report query
  against the DB is the typical next step.

## Relevance debugging techniques

If, after the first `relevance score` run, a specific keyword shows
poor results (too many off-topic products kept, or too many relevant
products dropped), positive / negative tag augmentation is one
available technique. It is NOT a routine setup step.

How it works: scoring builds the query for each keyword by combining
the keyword itself with any configured positive tags, and computes a
separate negative similarity penalty from negative tags. Adding tags
shifts the embedding query toward (or away from) particular product
categories without re-scraping.

When to suggest it:

- A keyword search returns many products from an unrelated category
  whose name happens to overlap (e.g. a brand name that collides with
  an unrelated popular product) → add `negative_extra` for that
  keyword under `per_keyword` in `relevance.yaml`.
- A whole vertical of relevant products is being scored too low
  → add a few representative category words to `positive_default`
  (these apply across all keywords).

Where to put them:

- `positive_default` / `negative_default` in `relevance.yaml` —
  applied to every keyword. Use sparingly and only when the issue
  is global, not keyword-specific.
- `per_keyword[<keyword>].negative_extra` / `positive_extra` —
  applied to one keyword only. Preferred for homonym issues.

After editing, re-run `node scripts/relevance.mjs score --keyword <k>`
to verify before re-exporting for review. Tag suggestions should be
derived from looking at the actual misclassified products, not
guessed up-front.

## After onboarding completes

Drop the welcome / setup framing. From the next user message onward,
behave like the normal workflow described in `SKILL.md`.
