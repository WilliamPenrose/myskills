# qly first-run onboarding

This document is loaded by `SKILL.md` when a user invokes the qly skill and
no `.qlydata/config.yaml` exists. Claude follows the steps below in order.

**Language note.** This skill is used by Chinese-speaking analysts. All
dialogue with the user must be in Chinese, even though the instructions in
this file are written in English. Adapt phrasing naturally to context, but
do not skip steps or drop information items.

**Business-language rule.** Never expose raw config keys to the user.
When asking about defaults or accepting custom values, describe what the
setting *means in the business* (e.g. "minimum livestream sales for an
influencer in the past 7 days, in yuan"), not the YAML key name (e.g.
NOT "min_gmv = 1"). Internally you map the user's business answer back
to the YAML key when writing the config file. The config keys exist in
the codebase only — users should never see them.

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

Frame this as: "qly's product search can pre-filter by price and by how
many units the product has sold in livestreams. This helps avoid pulling
in either ultra-cheap micro-items or rare items with almost no sales."

Default to keep products whose unit price is between **5 and 500 yuan**
and whose livestream-sold quantity is between **1 and 100,000 units**.

Ask via `AskUserQuestion` with three options:

1. "Use the defaults (price 5–500 yuan, livestream sales 1–100,000
   units)" — mark as "(Recommended)"
2. "Set a different price range"
3. "Set a different livestream-sales range"

If they pick option 2 or 3, follow up with free-form input asking for
the new minimum and maximum (in yuan / in units respectively). When
writing the config, translate these to `filters.price: [min, max]` and
`filters.live_sales: [min, max]` in `config.yaml`. The user never sees
the YAML key names.

## Step 5 — Q3: influencer thresholds (AskUserQuestion)

Frame this as: "for each kept product, qly tells us which influencers
have livestream-sold it recently. We want to focus on the ones who
actually moved meaningful volume — small-volume noise is usually not
worth chasing."

Two business-language settings:

- **Minimum livestream sales per influencer** in yuan, over the recent
  window. Default: **1 yuan** — i.e. effectively no filter; we keep
  every influencer who livestream-sold the product at all. Reviewers
  raise this threshold manually in the tracking xlsx if they want to
  trim noise.
- **Recent window** in days. Default: past 7 days.

Ask via `AskUserQuestion` with two options:

1. "Use the defaults (keep every influencer who livestream-sold the
   product in the past 7 days — no minimum sales filter)" — mark as
   "(Recommended)"
2. "Set a minimum sales threshold"

For option 2, ask in plain language:

- "影响者过去多少天内卖了多少元，才算值得跟踪？" — collect a yuan
  amount and a day count.

When writing the config:

- `influencer.min_gmv` is stored in **plain yuan** (no unit conversion).
  Default `1` means 1 yuan.
- `influencer.window_days` is integer days.

Never tell the user the YAML key names. Speak only in yuan and days.

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
