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
    const parsed = parseXmlFeed(await res.text());
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
  return `https://itunes.apple.com/${encodeURIComponent(country)}/rss/customerreviews/page=${page}/id=${encodeURIComponent(appId)}/sortby=${sortKey}/xml`;
}

function parseXmlFeed(xml) {
  const reviews = [];
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const review = normalizeXmlEntry(m[1]);
    if (review.rating !== null && review.reviewId.length > 0) reviews.push(review);
  }
  return reviews;
}

function normalizeXmlEntry(xml) {
  const reviewId = (xmlTag(xml, 'id') || stableFallback(xml)).trim();
  const title = dexml(xmlTag(xml, 'title'));
  const content = dexml(xmlTagTyped(xml, 'content', 'text'));
  const rating = numOrNull(xmlTag(xml, 'im:rating'));
  const helpfulCount = numOrNull(xmlTag(xml, 'im:voteSum'));
  const helpfulTotal = numOrNull(xmlTag(xml, 'im:voteCount'));
  const version = xmlTag(xml, 'im:version');
  const updated = xmlTag(xml, 'updated');
  const authorBlock = xml.match(/<author>([\s\S]*?)<\/author>/i)?.[1] ?? '';
  return {
    reviewId,
    userName: dexml(xmlTag(authorBlock, 'name')),
    userUrl: xmlTag(authorBlock, 'uri'),
    userImage: null,
    title,
    content,
    rating,
    helpfulCount,
    helpfulTotal,
    reviewCreatedVersion: version,
    appVersion: version,
    reviewedAt: updated ? new Date(updated).toISOString() : null,
    replyContent: null,
    repliedAt: null,
    raw: { xml },
  };
}

function xmlTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : null;
}

function xmlTagTyped(xml, tag, type) {
  const m = xml.match(new RegExp(`<${tag}\\s+type="${type}"[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : null;
}

function dexml(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'");
}

function numOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function stableFallback(s) {
  return createHash('sha1').update(s).digest('hex');
}
