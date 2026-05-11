import { createHash } from 'node:crypto';

// Apple's same-origin reviews API used by apps.apple.com itself.
// Anonymous: no token, no cookies, no UA required. Discovered 2026-04 by
// monkey-patching `fetch` inside the live App Store page; the Authorization
// header sent by Apple's own frontend is literally "Bearer " (empty) — the
// server doesn't validate it.
//
// Endpoint:
//   GET https://apps.apple.com/api/apps/v1/catalog/{country}/apps/{appId}/reviews
//       ?l={lang}&platform=web&limit={1..20}&offset={N}&sort=recent
//
// Behaviour:
//   - `limit` capped at 20; values 21+ return 400
//   - `sort=recent` is the only honored sort token (date-desc, monotonic
//     across pages); omitting `sort` falls back to Apple's mixed default
//   - Pagination via `offset`; response carries `next` until depleted
//   - 429 "API capacity exceeded" fires under burst load — handled by the
//     rate limiter + exponential backoff below
const PAGE_SIZE = 20;            // Apple's hard ceiling — fewer requests = less 429 risk
const MAX_PAGE_SIZE = 20;        // Apple's hard ceiling (values 21+ return HTTP 400)

const MIN_INTERVAL_MS = 3000;    // pacer between consecutive requests; raised
                                 // from 1500ms after observing Apple's IP
                                 // bucket runs dry after ~3 quick requests
                                 // (token refill ≈ 1 per 5s, so 3s gives a
                                 // little headroom while keeping throughput
                                 // tolerable). If 429s creep back, bump to
                                 // 5000ms — that matches the observed refill.
const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 5000;

let lastRequestAt = 0;
// `currentStats` is set by fetchIosReviews for the duration of one call so
// the pacer and retry helpers can attribute waits and 429s back to that
// invocation. It's null between calls. Module-level rather than threaded
// through every helper because lastRequestAt already has the same lifetime.
let currentStats = null;

function ts() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

async function paced(url) {
  const pacerWaitMs = Math.max(0, lastRequestAt + MIN_INTERVAL_MS - Date.now());
  if (pacerWaitMs > 0) {
    if (currentStats) currentStats.pacerWaitMs += pacerWaitMs;
    await new Promise((r) => setTimeout(r, pacerWaitMs));
  }
  lastRequestAt = Date.now();
  if (currentStats) currentStats.requests += 1;
  const t0 = Date.now();
  const res = await fetch(url);
  const serverMs = Date.now() - t0;
  if (currentStats) currentStats.serverMs += serverMs;
  return { res, serverMs, pacerWaitMs };
}

async function fetchWithRetry(url, { offset } = {}) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const { res, serverMs, pacerWaitMs } = await paced(url);
    if (res.ok) {
      const retryNote = attempt > 0 ? ` (retry ${attempt})` : '';
      const pacerNote = pacerWaitMs > 0 ? ` paced=${pacerWaitMs}ms` : '';
      console.error(`[${ts()}] iOS offset=${offset} ok server=${serverMs}ms${pacerNote}${retryNote}`);
      return res;
    }
    if (res.status === 429 && attempt < MAX_RETRIES) {
      if (currentStats) currentStats.retry429Count += 1;
      const retryAfter = parseInt(res.headers.get('retry-after') || '', 10);
      const usedRetryAfter = Number.isFinite(retryAfter) && retryAfter > 0;
      const wait = usedRetryAfter
        ? retryAfter * 1000
        : BASE_BACKOFF_MS * 2 ** attempt + Math.floor(Math.random() * 1000);
      if (currentStats) currentStats.backoffMs += wait;
      const retryAfterNote = usedRetryAfter ? ` retry-after=${retryAfter}s` : '';
      console.error(`[${ts()}] iOS offset=${offset} 429 attempt=${attempt + 1}/${MAX_RETRIES} server=${serverMs}ms backoff=${wait}ms${retryAfterNote}`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw new Error(`Apple App Store reviews request failed with HTTP ${res.status}.`);
  }
  throw new Error('Apple App Store reviews request failed: 429 retries exhausted.');
}

async function fetchOnePage({ appId, country, offset, apiSort, pageSize }) {
  const url = buildUrl({ appId, country, offset, apiSort, pageSize });
  const res = await fetchWithRetry(url, { offset });
  return res.json();
}

export async function fetchFirstPage({ appId, country, sort, pageSize = PAGE_SIZE }) {
  const apiSort = sort === 'newest' ? 'recent' : null;
  const cappedPageSize = Math.min(pageSize, MAX_PAGE_SIZE);
  return fetchOnePage({ appId, country, offset: 0, apiSort, pageSize: cappedPageSize });
}

export async function fetchIosReviews({ appId, country, sort, limit }) {
  // Map our sort vocab to Apple's. Only 'recent' is honored — the others
  // silently fall through to Apple's mixed-ranking default.
  const apiSort = sort === 'newest' ? 'recent' : null;
  const pageSize = Math.min(PAGE_SIZE, MAX_PAGE_SIZE);

  const stats = {
    pageSize,
    requests: 0,
    retry429Count: 0,
    pacerWaitMs: 0,
    serverMs: 0,
    backoffMs: 0,
    startedAt: Date.now(),
    totalMs: 0,
  };
  currentStats = stats;
  try {
    const reviews = [];
    let pages = 0;
    let offset = 0;

    while (reviews.length < limit) {
      const json = await fetchOnePage({ appId, country, offset, apiSort, pageSize });
      pages += 1;

      const data = Array.isArray(json.data) ? json.data : [];
      if (data.length === 0) break;

      for (const entry of data) {
        reviews.push(normalize(entry));
        if (reviews.length >= limit) break;
      }
      if (!json.next) break;
      offset += data.length;
    }
    stats.totalMs = Date.now() - stats.startedAt;
    return { reviews, pages, stats };
  } finally {
    currentStats = null;
  }
}

function buildUrl({ appId, country, offset, apiSort, pageSize }) {
  // Note: this endpoint accepts an `l` parameter (BCP 47 language tag) but
  // does not use it for review filtering — payloads are byte-identical
  // across `l=en-US`, `l=zh-TW`, `l=ja`, and omission. Verified empirically
  // 2026-04. We omit it.
  const params = new URLSearchParams({
    platform: 'web',
    limit: String(pageSize),
    offset: String(offset),
  });
  if (apiSort) params.set('sort', apiSort);
  return `https://apps.apple.com/api/apps/v1/catalog/${encodeURIComponent(country)}/apps/${encodeURIComponent(appId)}/reviews?${params.toString()}`;
}

function normalize(entry) {
  const a = entry.attributes || {};
  const reviewId = String(entry.id ?? stableFallback(JSON.stringify(entry)));
  const rating = typeof a.rating === 'number' ? a.rating : null;
  return {
    reviewId,
    userName: a.userName ?? null,
    userUrl: null,
    userImage: null,
    title: a.title ?? null,
    content: a.review ?? null,
    rating,
    helpfulCount: null,    // endpoint no longer exposes helpful votes
    helpfulTotal: null,
    reviewCreatedVersion: null, // per-review app version no longer exposed
    appVersion: null,
    reviewedAt: a.date ?? null,
    replyContent: null,    // not in this endpoint's payload
    repliedAt: null,
    raw: entry,
  };
}

function stableFallback(s) {
  return createHash('sha1').update(s).digest('hex');
}
