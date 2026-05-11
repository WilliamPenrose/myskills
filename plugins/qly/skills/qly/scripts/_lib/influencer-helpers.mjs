/**
 * Decide the "结论" (conclusion) for one pid in the tracking-list xlsx.
 * Mirrors generate-tracking-list.mjs exactly.
 */
export function decideConclusion({ nKept, nDropped, gmv7d, minGmv }) {
  if (nDropped > 0) return '不抓-人工 dropped';
  if (nKept > 0) {
    if (!Number.isFinite(gmv7d) || gmv7d < minGmv) return '不抓-销售额过低';
    return '抓';
  }
  return '不抓-未标注';
}

/**
 * Gating: decide whether to scrape this pid based on prior runs.
 * Returns { skip: bool, reason: string }.
 * Behavior matches influencer-batch.mjs gateDecision().
 */
export function gateDecision(db, pid, filter, args) {
  if (args.force) return { skip: false, reason: 'force' };

  const lastOk = db.prepare(`
    SELECT scraped_at FROM influencer_pid_runs
    WHERE pid=? AND filter=? AND status='ok'
    ORDER BY scraped_at DESC LIMIT 1
  `).get(pid, filter);
  if (lastOk) {
    const ageMs = Date.now() - new Date(lastOk.scraped_at).getTime();
    const windowMs = args.windowDays * 24 * 3600 * 1000;
    if (ageMs < windowMs) {
      return { skip: true, reason: `ok ${(ageMs / 86400000).toFixed(1)}d ago < ${args.windowDays}d window` };
    }
  }

  const lastFailed = db.prepare(`
    SELECT scraped_at, reason FROM influencer_pid_runs
    WHERE pid=? AND filter=? AND status='failed'
    ORDER BY scraped_at DESC LIMIT 1
  `).get(pid, filter);
  if (lastFailed) {
    if (args.retryAfterMs == null) {
      return { skip: true, reason: `prior failure (${lastFailed.reason || '?'}) — pass --retry to attempt again` };
    }
    const ageMs = Date.now() - new Date(lastFailed.scraped_at).getTime();
    if (ageMs < args.retryAfterMs) {
      return { skip: true, reason: `last failure ${(ageMs / 60000).toFixed(0)}m ago < retry window` };
    }
  }

  return { skip: false, reason: 'eligible' };
}

export function parseDuration(s) {
  const m = String(s).match(/^(\d+(?:\.\d+)?)([smhd])$/);
  if (!m) throw new Error(`bad duration "${s}" (expected e.g. 30s, 1h, 7d)`);
  const n = parseFloat(m[1]);
  const mul = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
  return n * mul;
}
