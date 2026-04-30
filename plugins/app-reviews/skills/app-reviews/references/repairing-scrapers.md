# Repairing scrapers (on drift)

Both `_lib/play.mjs` and `_lib/ios.mjs` scrape reverse-engineered private endpoints. They occasionally change shape without notice. This doc is the diagnostic recipe + repair discipline. Read it only when the signals below trigger; do not consult it for ordinary HTTP/rate-limit failures.

## When to read this

Read this when you see any of:

- A `fetch.mjs` error ending with `See references/repairing-scrapers.md` (parse-layer failure).
- The `health:` line in `fetch.mjs` stderr shows a key field at zero or near-zero non-null count given a non-trivial fetch (e.g. `100 fetched ... content=0/100`).
- `evaluate.mjs` JSON output looks structurally wrong: `rating` all null, `content` mostly empty, scores clustered abnormally despite a healthy fetch summary.
- The user reports that the analysis output looks structurally off (not "I disagree with the conclusions" — that's analysis, not drift).

Do **not** read this for:

- HTTP 4xx/5xx on the request itself.
- `429 retries exhausted` (rate limiting).
- `PlayGatewayError` (Google rate-limited or blocked the request).
- `unknown product`, missing `products.json`, or missing `play`/`ios` app id (operational config issues).

## Diagnostic recipe

1. **Pull a known-good historical sample from DB.** `fetch.mjs` stores every response's source row in `app_reviews.raw_json`. Pick the oldest entry for the target (product, platform, country):

   ```sql
   SELECT raw_json FROM app_reviews
   WHERE product_key = ? AND platform = ? AND country = ?
   ORDER BY first_seen_at ASC LIMIT 1;
   ```

   Save it to `/tmp/old-sample.json`.

2. **Fetch a fresh sample.** The `dump-raw.mjs` helper takes one page (size 10) of the current raw response without normalizing or writing to DB:

   ```bash
   node scripts/dump-raw.mjs --product <name> --platform play --country tw --lang zh-TW --out /tmp/new-sample.json
   node scripts/dump-raw.mjs --product <name> --platform ios  --country tw --out /tmp/new-sample.json
   ```

3. **Diff the structures, not the content.** Review text always differs across samples. Look for:
   - Renamed JSON keys (iOS).
   - Shifted array indices (Play uses `nested(source, [N, M, ...])` paths).
   - Changed nesting depth.
   - Fields that are present in old samples but absent (or vice versa) in new samples.

4. **Locate the affected normalize path.** Open `_lib/play.mjs` `normalize()` for Play, or `_lib/ios.mjs` `normalize()` for iOS. Each line in `normalize()` reads one source field. Match the broken health-summary field name against these lines.

5. **Verify the new path/key resolves.** Manually drill into the new sample's structure with a node REPL or `jq` and confirm the proposed new path returns a sensible value (correct type, plausible content).

## Patch discipline

- **Smallest possible change.** Usually one index path or one key name. Do not refactor `nested()`, do not change function signatures, do not introduce helpers.
- **Inline comment on the changed line:** `// YYYY-MM-DD: <field> moved from <old> to <new>`. Date and what only; the why goes in the commit message.
- **Regression check:** run `fetch.mjs` against a known-good (product, country) and confirm the `health:` summary's other fields still report healthy non-null counts (not just the field you fixed).
- **Do not change the DB schema.** If Apple/Google added a new field worth storing, that's a separate PR.
- **Do not edit other normalize fields "while you're here".** One drift, one fix, one commit.

## What to hand back to the user

You do not apply the diff. Hand back:

- A diagnosis summary: which field, the path/key before vs. after, evidence from the diff.
- A unified diff against `_lib/play.mjs` or `_lib/ios.mjs`.
- Verification output (showing the new path resolves on the new sample).
- The paths to `/tmp/old-sample.json` and `/tmp/new-sample.json` so the user can diff independently.

End with this fixed sentence:

> Apply the diff and re-run `fetch.mjs` on the same (product, country) to verify the health summary recovers.
