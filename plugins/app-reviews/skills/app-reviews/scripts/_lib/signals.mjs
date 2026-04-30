// Returns the UTF-8 byte length of the text after stripping every character
// that isn't a Unicode letter (\p{L}). This is the canonical "how much
// analyzable content does this review have" metric used in both the floor
// (junk gate) and the score (ranking weight).
//
// Why bytes-after-stripping rather than chars or raw bytes:
//   - Char count is biased: 1 CJK char ~= 2-3 ASCII chars in information
//     density, so a flat char threshold under-counts CJK content.
//   - Raw bytes are inflated by emoji and punctuation, which are emotional
//     padding rather than substance ("WHY???? 😡😡😡" looks long but is empty).
//   - Letters-only + UTF-8 byte count gives ASCII 1 byte/char, CJK 3
//     bytes/char, which roughly matches information density across scripts
//     while staying language-agnostic (works for any script in \p{L}).
export function meaningfulBytes(text) {
  const stripped = (text || '').replace(/[^\p{L}]/gu, '');
  return Buffer.byteLength(stripped, 'utf8');
}

// Recency boost: exponential decay with ~180 day characteristic time.
// At age 0 → 1.0; 30d → 0.85; 90d → 0.61; 180d → 0.37; 365d → 0.13.
// Magnitude (max +1.0) is comparable to rating/reply bonuses, so it tips
// ranking between otherwise close candidates without dominating substance.
// For a fast-iterating product, this naturally pushes feedback about old
// versions down the priority list without dropping it.
const RECENCY_HALF_LIFE_DAYS = 180;

export function recencyFactor(ageDays) {
  if (!Number.isFinite(ageDays) || ageDays < 0) return 0;
  return Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS);
}

// Higher = more valuable for analysis. All inputs are language-neutral.
//   - log(1 + meaningfulBytes): substance, diminishing returns
//   - log(1 + helpfulCount):    crowd validation, equal weight
//   - rating bonus:             negatives are most actionable
//   - reply bonus:              dev replies signal the team flagged it
//   - recency bonus:            recent feedback reflects the current product
export function analysisValueScore({ meaningfulBytes: mb, helpfulCount, rating, hasReply, ageDays }) {
  const ratingBonus = rating == null ? 0 : (rating <= 2 ? 1.0 : (rating <= 3 ? 0.3 : 0));
  const replyBonus = hasReply ? 0.5 : 0;
  const recencyBonus = ageDays == null ? 0 : recencyFactor(ageDays);
  return Math.log(1 + mb)
    + Math.log(1 + helpfulCount)
    + ratingBonus
    + replyBonus
    + recencyBonus;
}
