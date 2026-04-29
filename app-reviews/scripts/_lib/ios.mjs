import { createHash } from 'node:crypto';

const APPLE_REVIEWS_MAX_PAGES = 10;

export async function fetchIosReviews({ appId, country, sort, limit }) {
  const reviews = [];
  let pages = 0;
  for (let page = 1; page <= APPLE_REVIEWS_MAX_PAGES && reviews.length < limit; page += 1) {
    const url = buildUrl({ appId, country, sort, page });
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Apple App Store reviews request failed with HTTP ${res.status}.`);
    }
    pages += 1;
    const parsed = parseFeed(await res.json());
    if (parsed.length === 0) break;
    for (const review of parsed) {
      reviews.push(review);
      if (reviews.length >= limit) break;
    }
  }
  return { reviews, pages };
}

function buildUrl({ appId, country, sort, page }) {
  const sortKey = sort === 'helpful' || sort === 'relevant' ? 'mosthelpful' : 'mostrecent';
  return `https://itunes.apple.com/${encodeURIComponent(country)}/rss/customerreviews/page=${page}/id=${encodeURIComponent(appId)}/sortby=${sortKey}/json`;
}

function parseFeed(source) {
  const feed = objField(source, 'feed');
  const entries = arrayOrSingle(objField(feed, 'entry'));
  return entries
    .map((entry) => normalizeEntry(entry))
    .filter((review) => review.rating !== null && review.reviewId.length > 0);
}

function normalizeEntry(source) {
  const reviewId = parseReviewId(labelAt(source, ['id'])) || stableFallback(source);
  const reviewedAt = normalizeDate(labelAt(source, ['updated']));
  const appVersion = labelAt(source, ['im:version']);
  return {
    reviewId,
    userName: labelAt(source, ['author', 'name']),
    userUrl: labelAt(source, ['author', 'uri']),
    userImage: null,
    title: labelAt(source, ['title']),
    content: labelAt(source, ['content']),
    rating: numberOrNull(labelAt(source, ['im:rating'])),
    helpfulCount: numberOrNull(labelAt(source, ['im:voteSum'])),
    helpfulTotal: numberOrNull(labelAt(source, ['im:voteCount'])),
    reviewCreatedVersion: appVersion,
    appVersion,
    reviewedAt,
    replyContent: null,
    repliedAt: null,
    raw: source,
  };
}

function objField(s, k) { return (!s || typeof s !== 'object' || Array.isArray(s)) ? undefined : s[k]; }
function arrayOrSingle(v) { return Array.isArray(v) ? v : (v == null ? [] : [v]); }
function labelAt(s, p) {
  let c = s;
  for (const k of p) { c = objField(c, k); if (c == null) return null; }
  if (typeof c === 'string') return c;
  if (c && typeof c === 'object' && !Array.isArray(c)) {
    return typeof c.label === 'string' ? c.label : null;
  }
  return null;
}
function parseReviewId(v) { if (!v) return ''; const t = v.trim(); const m = /\/id(\d+)(?:[/?#]|$)/.exec(t); return m ? m[1] : t; }
function stableFallback(s) { return createHash('sha1').update(JSON.stringify(s)).digest('hex'); }
function normalizeDate(v) { if (!v) return null; const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : v; }
function numberOrNull(v) { if (v === null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
