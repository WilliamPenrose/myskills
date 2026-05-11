# Repairing qly scrapers when qlydata UI drifts

This skill drives qlydata.com's UI directly (no API). qly occasionally tweaks the DOM/AX or backend signal. When something stops working, walk this list before assuming a skill bug.

## Symptoms → first-suspect

| Symptom | Suspect | Where to look |
|---|---|---|
| `products` filter click times out | Price/sales/time filter panel re-shaped | `_lib/actions.mjs` setPriceRange / setLivestreamSales |
| Export button click runs but no xlsx arrives | Export hotkey/menu changed | `_lib/actions.mjs` triggerExport |
| Search ignores keyword | Search input AX changed | `_lib/actions.mjs` searchKeyword |
| `influencer fetch` returns 0 uids for known-good pids | existLive URL pattern changed | `_lib/influencer-extract.mjs` |
| Scripts hit "请登录" mid-batch | Session expired (not a bug) | `_lib/session.mjs` — re-login in chrome |
| Banner "今日访问次数已达上限" — exit 1 | Daily quota (~920) hit | Wait until next day |

## Diagnosis workflow

1. **Reproduce manually**: open chrome with site-use's profile, navigate to qlydata, do the action by hand. Does qly itself work?
2. **Take a fresh DOM snapshot**: write a one-off probe that calls `primitives.takeSnapshot()` and dump to JSON. Compare to the AX/role names actions.mjs expects.
3. **Find the changed selector**: AX-based selectors (uid lookups by role+name) tend to break when qly renames a button or wraps it in a new container. Update the lookup in actions.mjs.
4. **For XHR drift**: open chrome devtools network tab while running the action manually. Look for the URL pattern `_lib/influencer-extract.mjs` watches (`/common/exist/live`). If qly switched to a different endpoint, update the pattern.

## Don't

- Don't add retry loops around UI clicks to "make it work" — that fights the rate-limiter rather than fixing the selector
- Don't bypass `session.assertSession()` to "skip" the login check — you'll get banned faster
- Don't `--force` a fetch when gate is skipping; investigate why first
- Don't regenerate `references/` from the live DOM — those drift docs become stale immediately

## Logging

stderr is redirected via `_lib/log-redirect.mjs` to `.qlydata/.logs/<script>.log`. Tail that file to see why a run failed. Use `term()` for messages that should also appear in the terminal.

## Session expiry conservatism

`_lib/session.mjs` checks 4 signals. **Don't trigger session_lost on broad URL conditions** — false positives abort otherwise-recoverable batches. Restrict to specific dialog / form / captcha / hard-redirect-to-login signals.
