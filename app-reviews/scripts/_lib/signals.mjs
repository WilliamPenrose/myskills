export const SIGNAL_GROUPS = {
  pricing: /\b(gems?|jems?|coins?|subscription|subscribe|pay|paid|money|free|cost|price|purchase|currency|diamonds?|premium)\b/i,
  usage:   /\b(message|messages|chat|chats|wait|daily|limit|limits|talk|reply|replies|response|responses)\b/i,
  quality: /\b(memory|model|models|character|characters|story|roleplay|scenario|scenarios|bot|bots|ai|intelligence)\b/i,
  feature: /\b(image|video|ads?|advert|filter|create|custom|code|codes|voice|login|account)\b/i,
  issue:   /\b(warning|update|load|loading|bug|crash|lag|lagging|error|errors|broken|stuck|slow)\b/i,
};

export function computeSignalFlags(content) {
  return {
    has_pricing_signal: SIGNAL_GROUPS.pricing.test(content) ? 1 : 0,
    has_usage_signal:   SIGNAL_GROUPS.usage.test(content) ? 1 : 0,
    has_quality_signal: SIGNAL_GROUPS.quality.test(content) ? 1 : 0,
    has_feature_signal: SIGNAL_GROUPS.feature.test(content) ? 1 : 0,
    has_issue_signal:   SIGNAL_GROUPS.issue.test(content) ? 1 : 0,
  };
}

export function signalNamesFromFlags(flags) {
  const out = [];
  if (flags.has_pricing_signal) out.push('pricing');
  if (flags.has_usage_signal)   out.push('usage');
  if (flags.has_quality_signal) out.push('quality');
  if (flags.has_feature_signal) out.push('feature');
  if (flags.has_issue_signal)   out.push('issue');
  return out;
}

export function countWords(content) {
  const m = content.match(/[A-Za-z0-9]+/g);
  return m ? m.length : 0;
}

export function analysisValueScore({ combinedLength, helpfulCount, signalCount, rating }) {
  return Math.log(1 + combinedLength)
    + 0.5 * Math.log(1 + helpfulCount)
    + signalCount
    + (rating != null && rating <= 3 ? 0.5 : 0);
}
