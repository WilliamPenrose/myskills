const PLAY_BASE = 'https://play.google.com';
const MAX_COUNT_EACH_FETCH = 4500;
const SORT_CODES = { relevant: 1, newest: 2, rating: 3 };
const RESPONSE_PREFIX_REGEX = /^\)\]\}'\n\n([\s\S]+)$/;

export async function fetchPlayReviews({ appId, country, lang, sort, limit }) {
  if (limit < 1) throw new Error('--limit must be a positive integer');
  const reviews = [];
  let paginationToken = null;
  let pages = 0;

  while (reviews.length < limit) {
    const count = Math.min(MAX_COUNT_EACH_FETCH, limit - reviews.length);
    const page = await fetchPage({ appId, country, lang, sort, count, paginationToken });
    pages += 1;
    for (const item of page.reviewItems) {
      const normalized = normalize(item);
      if (normalized.reviewId) reviews.push(normalized);
      if (reviews.length >= limit) break;
    }
    paginationToken = page.paginationToken;
    if (!paginationToken || page.reviewItems.length === 0) break;
  }
  return { reviews, pages };
}

export async function fetchPageRaw({ appId, country, lang, sort, count, paginationToken }) {
  const url = new URL('/_/PlayStoreUi/data/batchexecute', PLAY_BASE);
  url.searchParams.set('hl', lang);
  url.searchParams.set('gl', country);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: buildReviewsRequestBody({ appId, sort, count, paginationToken }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Google Play request failed with ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  }
  if (text.includes('com.google.play.gateway.proto.PlayGatewayError')) {
    throw new Error('Google Play rejected the reviews request with PlayGatewayError.');
  }
  const m = RESPONSE_PREFIX_REGEX.exec(text);
  if (!m) throw new Error('Google Play returned an unexpected reviews response prefix. See references/repairing-scrapers.md.');
  return m[1];
}

async function fetchPage(args) {
  const inner = await fetchPageRaw(args);
  return parseResponse(inner);
}

function buildReviewsRequestBody({ appId, sort, count, paginationToken }) {
  const pageArgs = paginationToken ? [count, null, paginationToken] : [count];
  const requestPayload = [
    null,
    [2, SORT_CODES[sort], pageArgs, null, [null, null, null, null, null, null, null, null, null]],
    [appId, 7],
  ];
  const batch = [[['oCPfdb', JSON.stringify(requestPayload), null, 'generic']]];
  return new URLSearchParams({ 'f.req': JSON.stringify(batch) }).toString();
}

function parseResponse(inner) {
  const outer = JSON.parse(inner);
  const payloadText = nested(outer, [0, 2]);
  if (typeof payloadText !== 'string') throw new Error('Google Play reviews response missing payload. See references/repairing-scrapers.md.');
  const payload = JSON.parse(payloadText);
  const reviewItems = nested(payload, [0]);
  const tokenContainer = Array.isArray(payload) && payload.length >= 2 ? payload[payload.length - 2] : undefined;
  const paginationToken = Array.isArray(tokenContainer) && typeof tokenContainer[tokenContainer.length - 1] === 'string'
    ? tokenContainer[tokenContainer.length - 1]
    : null;
  return { reviewItems: Array.isArray(reviewItems) ? reviewItems : [], paginationToken };
}

function normalize(source) {
  return {
    reviewId: stringOrEmpty(nested(source, [0])),
    userName: stringOrNull(nested(source, [1, 0])),
    userUrl: null,
    userImage: stringOrNull(nested(source, [1, 1, 3, 2])),
    title: null,
    content: stringOrNull(nested(source, [4])),
    rating: numberOrNull(nested(source, [2])),
    helpfulCount: numberOrNull(nested(source, [6])),
    helpfulTotal: numberOrNull(nested(source, [6])),
    reviewCreatedVersion: stringOrNull(nested(source, [10])),
    appVersion: stringOrNull(nested(source, [10])),
    reviewedAt: tsToIso(nested(source, [5, 0])),
    replyContent: stringOrNull(nested(source, [7, 1])),
    repliedAt: tsToIso(nested(source, [7, 2, 0])),
    raw: source,
  };
}

function nested(s, p) { let c = s; for (const k of p) { if (!Array.isArray(c)) return undefined; c = c[k]; } return c; }
function stringOrEmpty(v) { return typeof v === 'string' ? v : ''; }
function stringOrNull(v) { return typeof v === 'string' ? v : null; }
function numberOrNull(v) { return typeof v === 'number' ? v : null; }
function tsToIso(v) { return typeof v === 'number' ? new Date(v * 1000).toISOString() : null; }
