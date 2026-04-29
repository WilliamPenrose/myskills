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
const PAGE_SIZE = 10;            // friendly to rate limit; user requested default
const MAX_PAGE_SIZE = 20;        // Apple's hard ceiling

const MIN_INTERVAL_MS = 1500;    // pacer between consecutive requests
const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 5000;

let lastRequestAt = 0;
async function paced(url) {
  const wait = Math.max(0, lastRequestAt + MIN_INTERVAL_MS - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
  return fetch(url);
}

async function fetchWithRetry(url) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const res = await paced(url);
    if (res.ok) return res;
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '', 10);
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : BASE_BACKOFF_MS * 2 ** attempt + Math.floor(Math.random() * 1000);
      console.error(`  iOS reviews: 429, backing off ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw new Error(`Apple App Store reviews request failed with HTTP ${res.status}.`);
  }
  throw new Error('Apple App Store reviews request failed: 429 retries exhausted.');
}

export async function fetchIosReviews({ appId, country, sort, limit }) {
  // Map our sort vocab to Apple's. Only 'recent' is honored — the others
  // silently fall through to Apple's mixed-ranking default.
  const apiSort = sort === 'newest' ? 'recent' : null;
  const pageSize = Math.min(PAGE_SIZE, MAX_PAGE_SIZE);

  const reviews = [];
  let pages = 0;
  let offset = 0;

  while (reviews.length < limit) {
    const url = buildUrl({ appId, country, offset, apiSort, pageSize });
    const res = await fetchWithRetry(url);
    pages += 1;

    const json = await res.json();
    const data = Array.isArray(json.data) ? json.data : [];
    if (data.length === 0) break;

    for (const entry of data) {
      reviews.push(normalize(entry));
      if (reviews.length >= limit) break;
    }
    if (!json.next) break;
    offset += data.length;
  }
  return { reviews, pages };
}

function buildUrl({ appId, country, offset, apiSort, pageSize }) {
  const params = new URLSearchParams({
    l: 'en-US',
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
