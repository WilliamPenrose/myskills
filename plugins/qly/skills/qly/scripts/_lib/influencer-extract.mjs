// Extract influencer UIDs for one product from qlydata 带货达人 panel by
// driving the UI like a human: navigate → click tabs → click filters,
// then read UIDs from the plaintext /common/exist/live request URL.
//
// Why UI-driven (not direct API): qly's userList response is encrypted
// and direct API calls from a script would stand out in their rate-
// monitoring dashboard. Human-paced clicks reuse the page's own auth
// + behavior fingerprint and stay below the alarm threshold.
//
// Why exist/live for UIDs: the response of /goods/userList itself is
// AES-encrypted, but qly's frontend, after rendering, calls
// /common/exist/live?uids=<csv>&pid=... to check live status — and
// that URL leaks UIDs in plaintext. Same pattern works for any pId.
//
// Pagination: userList paginates with `from=1, from=2, ...`. The page
// auto-fetches subsequent pages as the user scrolls. For batch, we
// scroll the influencer table to the bottom to force all pages,
// collecting every exist/live URL that fires.

import { sleep } from './actions.mjs';
import { assertSession, checkSessionDeep } from './session.mjs';

const NAV_TIMEOUT = 25000;
const STEP_TIMEOUT = 12000;

export async function extractInfluencerUids({
  page, primitives, pid,
  time = 7,        // 1=今日, 3=近3天, 7=近7天, 30=近30天
  type = 'live',   // 'live'=直播带货, 'video'=视频带货, ''=全部
  log = (m) => console.error(`[infl ${pid}] ${m}`),
} = {}) {
  if (!pid) throw new Error('pid required');

  const targetUrl = `https://qlydata.com/#/market_rank/goods/goods_search/goods_detail?pId=${pid}`;

  // Network capture: collect every /common/exist/live URL fired while
  // we work; plus track userList params so we can verify each filter
  // step actually re-issued the request with the right params.
  const captured = { existLive: [], userList: [] };
  const onResp = async (resp) => {
    try {
      const u = resp.url();
      if (u.includes('/common/exist/live')) {
        const url = new URL(u);
        const uids = (url.searchParams.get('uids') || '').split(',').filter(Boolean);
        const cpid = url.searchParams.get('pid') || '';
        if (cpid === String(pid)) captured.existLive.push({ uids, ts: Date.now() });
      } else if (u.includes('/goods/userList')) {
        const url = new URL(u);
        captured.userList.push({
          time: url.searchParams.get('time'),
          type: url.searchParams.get('type'),
          from: url.searchParams.get('from'),
          ts: Date.now(),
        });
      }
    } catch {}
  };
  page.on('response', onResp);

  // Per-phase timing. Each call returns elapsed ms since the timer
  // started — emitted via log so batch callers can see where time
  // goes per pid.
  const overall = Date.now();
  const timings = {};
  const time_step = (label) => {
    const t0 = Date.now();
    return () => {
      const dt = Date.now() - t0;
      timings[label] = dt;
      log(`step=${label} took=${dt}ms`);
      return dt;
    };
  };

  try {
    let done = time_step('navigate');
    log(`navigate ${targetUrl}`);
    // qly is a Vue SPA with hash routing. page.goto to a different
    // hash on the same origin lets Vue Router intercept — no real
    // navigation, networkidle returns instantly, the page looks
    // unchanged. To force a clean component remount for the new pid,
    // always set hash then reload (no-op when already on this URL).
    if (page.url() !== targetUrl) {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    }
    await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    // Cheap session check: URL-form expiry is detectable instantly, so do
    // that here. Dialog-form expiry (URL still on /goods_detail, but a
    // "登录状态已失效" modal is up) is checked LATER, only if the influencer
    // tab fails to appear — by then the modal has had clickByName's full
    // 12s deadline window to render. Avoids the previous fixed 2.5s sleep
    // that was solely there to give the modal time to render before an
    // eager AX snapshot.
    // Cheap session check post-reload — only catches the URL-form expiry
    // (Vue Router synchronous intercept). Dialog/captcha forms are
    // handled lazily on the clickByName failure path below to avoid
    // paying for a full snapshot on every healthy pid.
    await assertSession({ page });
    done();

    done = time_step('tab-influencer');
    log('open 带货达人 tab');
    if (!await clickByName(primitives, '带货达人', 'tab', log)) {
      // clickByName polled 12s and never saw the tab. Run the deep
      // session check to differentiate genuine session-loss (abort the
      // batch) from any other unexpected state (let consec-failure
      // catch it).
      const { reason, nodeCount } = await checkSessionDeep({ page, primitives });
      if (reason) throw new Error(`SessionExpired: ${reason}`);
      throw new Error(`InfluencerTabNotFound (nodes=${nodeCount})`);
    }
    await waitForUserList(captured, STEP_TIMEOUT, log, 'after 带货达人');
    done();

    // Top-to-bottom click order matches human flow: 时间 sits at the
    // top of the panel (in viewport), 直播带货 sub-tab is below the fold.
    // Going time → type also lets the second click filter on top of an
    // already-narrowed list, the same way a real user would.
    done = time_step(`time-${time}`);
    log(`apply 时间=${timeLabel(time)}`);
    const timeRes = await pickTimeOption(primitives, time, log);
    if (!timeRes.ok) {
      if (timeRes.quotaExceeded) throw new Error('QuotaExceeded: 今日访问次数已达上限');
      throw new Error('TimeOptionNotApplied');
    }
    await waitForUserListWith(captured, { time: String(time) }, STEP_TIMEOUT, log, `after time=${time}`);
    done();

    done = time_step('tab-live');
    log('open 直播带货 sub-tab');
    if (!await clickByName(primitives, '直播带货', 'button', log)) {
      throw new Error('LiveSalesSubTabNotFound');
    }
    await waitForUserListWith(captured, { time: String(time), type: 'live' }, STEP_TIMEOUT, log, 'after 直播带货');
    done();

    done = time_step('scroll');
    log('scroll influencer table to force pagination');
    // userList paginates with from=1,2,3,...; the page lazy-loads the
    // next page when its real scroll container reaches the bottom. The
    // real container is #page_content_wrap, NOT .ant-table-body
    // (ant-table-body has scrollHeight===clientHeight here, so writing
    // its scrollTop is a no-op). Scroll in a loop, waiting for a NEW
    // matching-filter userList after each scroll; exit when no new
    // userList fires within NO_PROGRESS_DEADLINE_MS, which means the
    // backend has no further pages.
    const targetTimeStr = String(time);
    const targetTypeStr = type ?? '';
    const PAGE_SIZE = 10;             // qly userList page size
    const MAX_SCROLLS = 30;
    const USERLIST_DEADLINE_MS = 2500;
    const EXISTLIVE_DEADLINE_MS = 2500;
    const filterUserLists = () => captured.userList
      .filter((c) => c.time === targetTimeStr && (c.type ?? '') === targetTypeStr);
    const filterCutoffTs = () => {
      const ts = filterUserLists().map((c) => c.ts).sort((a, b) => a - b)[0];
      return ts ?? Infinity;
    };
    let scrollIters = 0;
    let earlyExitShortPage = false;
    // Pre-loop short-circuit: if page 1 itself is the last page (its
    // existLive has uids<10), skip the scroll loop entirely. Page-1's
    // existLive fires ~50-200ms after the sub-tab click's userList,
    // which has already returned by the time we get here, so wait
    // briefly for that EL before deciding.
    {
      const cutoffTs = filterCutoffTs();
      const dl = Date.now() + 1500;
      while (Date.now() < dl) {
        if (captured.existLive.some((e) => e.ts >= cutoffTs)) break;
        await sleep(100);
      }
      const shortPage = captured.existLive.find((e) => e.ts >= cutoffTs && e.uids.length < PAGE_SIZE);
      if (shortPage) {
        log(`scroll: page 1 already short (existLive uids=${shortPage.uids.length} < ${PAGE_SIZE}) — skip scroll loop`);
        earlyExitShortPage = true;
      }
    }
    for (let i = 0; !earlyExitShortPage && i < MAX_SCROLLS; i++) {
      scrollIters = i + 1;
      const userListBefore = filterUserLists().length;
      const existLiveBefore = captured.existLive.length;
      await scrollInfluencerTable(page, primitives);

      // Wait for the next paginated userList(filter). If none arrives
      // within USERLIST_DEADLINE_MS, the backend has no further pages
      // and we exit.
      const ulDeadline = Date.now() + USERLIST_DEADLINE_MS;
      let userListFired = false;
      while (Date.now() < ulDeadline) {
        if (filterUserLists().length > userListBefore) { userListFired = true; break; }
        await sleep(150);
      }
      if (!userListFired) {
        log(`scroll iter ${i + 1}: no new userList within ${USERLIST_DEADLINE_MS}ms — pagination exhausted`);
        break;
      }

      // Wait for that page's existLive. qly's frontend appears to
      // serialize existLive after userList renders; without this
      // pacing, fast back-to-back scrolls can drop earlier pages'
      // existLive calls. Pacing also lets us inspect the new EL's
      // size for the short-page early-exit below.
      const elDeadline = Date.now() + EXISTLIVE_DEADLINE_MS;
      while (Date.now() < elDeadline) {
        if (captured.existLive.length > existLiveBefore) break;
        await sleep(150);
      }
      const newEls = captured.existLive.slice(existLiveBefore);
      if (newEls.length === 0) {
        log(`scroll iter ${i + 1}: userList fired but no new existLive within ${EXISTLIVE_DEADLINE_MS}ms`);
        continue;
      }

      // Page size = 10. Any post-cutoff existLive with fewer than 10
      // UIDs means a "last page" arrived — no need to scroll again or
      // wait the full 2.5s "no new userList" timeout. existLive can
      // arrive out of order (e.g. page 3's EL before page 2's), so
      // scan all post-cutoff ELs each iter, not just the ones that
      // landed in this iter's window.
      const cutoffTs = filterCutoffTs();
      const shortPage = captured.existLive.find((e) => e.ts >= cutoffTs && e.uids.length < PAGE_SIZE);
      if (shortPage) {
        log(`scroll iter ${i + 1}: short page (existLive uids=${shortPage.uids.length} < ${PAGE_SIZE}) — last page, exit early`);
        earlyExitShortPage = true;
        break;
      }
    }

    // Settle: ensure every post-cutoff userList(filter) has its
    // matching existLive captured. existLive can fire out-of-order
    // (e.g. page 3's EL before page 2's), so we wait for counts to
    // match rather than just "any post-cutoff EL". Empty pids satisfy
    // this trivially (1 UL → 1 EL with uids=[]).
    {
      const cutoff = filterCutoffTs();
      if (cutoff !== Infinity) {
        const want = filterUserLists().length;
        const waitDeadline = Date.now() + 3000;
        while (Date.now() < waitDeadline) {
          const got = captured.existLive.filter((e) => e.ts >= cutoff).length;
          if (got >= want) break;
          await sleep(150);
        }
        const got = captured.existLive.filter((e) => e.ts >= cutoff).length;
        if (got < want) {
          log(`scroll: post-loop settle timed out — existLive(post-cutoff)=${got} < userList(filter)=${want}; some UIDs may be missing`);
        }
      }
    }
    log(`scroll: ${scrollIters} iter(s); userList(filter)=${filterUserLists().length}; earlyExit=${earlyExitShortPage}`);
    done();

    // Only count exist/live UIDs that fired AFTER the final userList
    // (time=<time>,type=<type>) — earlier exist/live calls reflect the
    // unfiltered or partially-filtered list and would inflate the
    // result. Use the first matching userList's timestamp as the
    // cutoff; subsequent paginated userList calls under the same
    // filter are also fine since their exist/live ts is later still.
    const finalUserLists = captured.userList
      .filter((c) => c.time === String(time) && c.type === (type ?? ''))
      .sort((a, b) => a.ts - b.ts);
    const cutoffTs = finalUserLists[0]?.ts ?? Infinity;

    const all = new Set();
    let countedCalls = 0;
    for (const e of captured.existLive) {
      if (e.ts < cutoffTs) continue;
      countedCalls += 1;
      for (const id of e.uids) all.add(id);
    }

    const totalMs = Date.now() - overall;
    log(`captured: ${captured.userList.length} userList calls, ${captured.existLive.length} exist/live calls (${countedCalls} after final filter), ${all.size} unique uids matching filter; final-filter userList: ${finalUserLists.length}; TOTAL=${totalMs}ms`);
    // Verbose XHR trace — when uids=0 we need to see why (whether the
    // exist/live really happened, what its ts was relative to cutoff).
    if (all.size === 0) {
      const startTs = captured.userList[0]?.ts ?? captured.existLive[0]?.ts ?? Date.now();
      log(`  XHR trace (cutoffTs=+${cutoffTs - startTs}ms):`);
      const merged = [
        ...captured.userList.map((c) => ({ ts: c.ts, kind: 'userList', detail: `time=${c.time} type=${c.type} from=${c.from}` })),
        ...captured.existLive.map((c) => ({ ts: c.ts, kind: 'existLive', detail: `uids=${c.uids.length}` })),
      ].sort((a, b) => a.ts - b.ts);
      for (const m of merged) log(`    [+${m.ts - startTs}ms] ${m.kind} ${m.detail}`);
    }

    return {
      pid, time, type,
      uids: [...all],
      userListCalls: captured.userList,
      existLiveCalls: captured.existLive.length,
      existLiveCallsAfterFilter: countedCalls,
      finalFilterUserListCount: finalUserLists.length,
      timings,
      totalMs,
    };
  } finally {
    page.off('response', onResp);
  }
}

function timeLabel(t) {
  return ({ 1: '今日', 3: '近3天', 7: '近7天', 30: '近30天' })[t] ?? `time=${t}`;
}

async function clickByName(primitives, name, role, log, { timeoutMs = 12000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastDiag = null;
  while (Date.now() < deadline) {
    const sn = await primitives.takeSnapshot();
    const candidates = [...sn.idToNode.values()].filter(
      (n) => typeof n.name === 'string' && n.name.trim() === name
        && (role == null || n.role === role)
    );
    if (candidates.length === 0) {
      const tabs = [...sn.idToNode.values()].filter((n) => n.role === 'tab');
      const fuzzy = [...sn.idToNode.values()].filter((n) => typeof n.name === 'string' && n.name.includes(name));
      lastDiag = {
        nodeCount: sn.idToNode.size,
        tabs: tabs.map((n) => `${n.uid}:"${n.name}"`).slice(0, 20),
        fuzzyMatches: fuzzy.map((n) => `${n.uid}:${n.role}:"${n.name.slice(0, 30)}"`).slice(0, 10),
      };
    }
    if (candidates.length > 0) {
      candidates.sort((a, b) => Number(a.uid) - Number(b.uid));
      const pick = candidates[0];
      // primitives.click does NOT auto-scrollIntoView; its occlusion check
      // calls DOM.getNodeForLocation which fails for points outside the
      // viewport with "No node found at given location". qly's influencer
      // sub-tabs (直播带货 etc.) render below the fold at common viewport
      // heights — scroll the exact AX uid (uses backendNodeId, not text)
      // into view before clicking.
      try {
        await primitives.scrollIntoView(pick.uid);
        await sleep(200);
      } catch {}
      log(`click "${name}" uid=${pick.uid} role=${pick.role}`);
      try {
        await primitives.click(pick.uid);
      } catch (e) {
        const msg = String(e?.message || e);
        if (msg.includes('No node found') || msg.includes('Could not compute box')) {
          log(`click "${name}" stale uid=${pick.uid} (${msg.slice(0, 80)}); resnap+retry`);
          await sleep(500);
          continue;
        }
        throw e;
      }
      return true;
    }
    await sleep(200);
  }
  log(`! "${name}" (role=${role || 'any'}) not found within ${timeoutMs}ms`);
  if (lastDiag) {
    log(`  diag: AX nodes=${lastDiag.nodeCount}`);
    log(`  diag: tabs=${lastDiag.tabs.join(' | ') || '<none>'}`);
    log(`  diag: fuzzy "${name}"=${lastDiag.fuzzyMatches.join(' | ') || '<none>'}`);
  }
  return false;
}

// Pick a time-range option ("近7天" etc.) from the influencer panel.
//
// AX layout (after panel renders):
//   - trigger label   role=button name="近30天" (currently-selected value)
//   - dropdown items  role in {menuitem, menuitemradio, button}, name in
//                     {今日, 近3天, 近7天, 近30天, ...}
// The dropdown items' role varies by Ant version / mount state; we
// accept any of those interactive roles when matching the option.
async function pickTimeOption(primitives, time, log) {
  const targetLabel = timeLabel(time);
  const TIME_LABELS = new Set(['今日', '近3天', '近7天', '近30天', '近90天', '近180天', '近一年']);
  const OPTION_ROLES = new Set(['button', 'menuitem', 'menuitemradio', 'option', 'radio']);

  // Poll for the trigger button: qly mounts the filter panel a few hundred
  // ms after the userList response returns. Without this loop, a single
  // pre-snapshot can race the panel mount and fail with "no time-label
  // button found" — clickByName uses the same pattern for its targets.
  const findDeadline = Date.now() + 5000;
  let trigger = null;
  while (Date.now() < findDeadline) {
    const pre = await primitives.takeSnapshot();
    const buttons = [...pre.idToNode.values()]
      .filter((n) => n.role === 'button' && TIME_LABELS.has((n.name || '').trim()));
    if (buttons.length > 0) {
      buttons.sort((a, b) => Number(a.uid) - Number(b.uid));
      trigger = buttons[0];
      break;
    }
    await sleep(300);
  }
  if (!trigger) {
    log('! no time-label button found within 5s');
    return { ok: false, clicked: false };
  }
  log(`time trigger uid=${trigger.uid} currently="${trigger.name}"`);

  if (trigger.name.trim() === targetLabel) {
    log(`time already set to ${targetLabel}`);
    return { ok: true, clicked: false };
  }

  // Open the dropdown. Scroll into view first (occlusion check fails
  // outside viewport). On stale backendNodeId, resnap once.
  try { await primitives.scrollIntoView(trigger.uid); await sleep(200); } catch {}
  try {
    await primitives.click(trigger.uid);
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes('No node found') || msg.includes('Could not compute box')) {
      log(`time trigger stale; resnap+retry`);
      await sleep(500);
      const re = await primitives.takeSnapshot();
      const t = [...re.idToNode.values()]
        .filter((n) => n.role === 'button' && TIME_LABELS.has((n.name || '').trim()))
        .sort((a, b) => Number(a.uid) - Number(b.uid))[0];
      if (!t) return { ok: false, clicked: false };
      try { await primitives.scrollIntoView(t.uid); await sleep(200); } catch {}
      await primitives.click(t.uid);
    } else {
      throw e;
    }
  }

  // Snapshot first, then sleep — the dropdown often appears within ~150ms
  // of the trigger click, and snapshotting first lets us catch that fast
  // path without paying a 300ms idle wait every iteration.
  const deadline = Date.now() + 5000;
  let option = null;
  while (Date.now() < deadline) {
    const post = await primitives.takeSnapshot();
    const options = [...post.idToNode.values()]
      .filter((n) => OPTION_ROLES.has(n.role) && (n.name || '').trim() === targetLabel
        && n.uid !== trigger.uid)
      .sort((a, b) => Number(b.uid) - Number(a.uid));
    if (options.length > 0) { option = options[0]; break; }
    await sleep(200);
  }
  if (!option) {
    const dbg = await primitives.takeSnapshot();
    // Account-level daily quota exhaustion shows a global banner that
    // displaces dropdown options. Surface as a distinct signal so batch
    // can abort instead of burning every remaining pid into 'failed'.
    const quotaHit = [...dbg.idToNode.values()].some((n) =>
      typeof n.name === 'string' && n.name.includes('今日访问次数已达上限'));
    if (quotaHit) {
      log('! QuotaExceeded: "今日访问次数已达上限" banner present');
      return { ok: false, clicked: true, quotaExceeded: true };
    }
    const all = [...dbg.idToNode.values()]
      .filter((n) => typeof n.name === 'string' && /近|今|天|日/.test(n.name) && n.name.length < 30)
      .map((n) => `${n.uid}:${n.role}:"${n.name}"`);
    log(`! "${targetLabel}" option not found. Time-related nodes: ${all.slice(0, 25).join(' | ')}`);
    return { ok: false, clicked: true };
  }
  log(`click "${targetLabel}" option uid=${option.uid}`);
  // The dropdown is already open; clicking an option immediately is
  // human-plausible (a real user picks within ~100-500ms of seeing
  // the menu, not the conservative 0.5-1s tab-click pacing). Tighten
  // throttle for this single click via per-call override.
  const FAST_OPTION_THROTTLE = { minDelay: 100, maxDelay: 500 };
  try { await primitives.scrollIntoView(option.uid); await sleep(200); } catch {}
  try {
    await primitives.click(option.uid, { throttle: FAST_OPTION_THROTTLE });
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes('No node found') || msg.includes('Could not compute box')) {
      log(`option click stale; resnap+retry`);
      await sleep(500);
      const re = await primitives.takeSnapshot();
      const o = [...re.idToNode.values()]
        .filter((n) => OPTION_ROLES.has(n.role) && (n.name || '').trim() === targetLabel
          && n.uid !== trigger.uid)
        .sort((a, b) => Number(b.uid) - Number(a.uid))[0];
      if (!o) return { ok: false, clicked: true };
      try { await primitives.scrollIntoView(o.uid); await sleep(200); } catch {}
      await primitives.click(o.uid, { throttle: FAST_OPTION_THROTTLE });
    } else {
      throw e;
    }
  }
  return { ok: true, clicked: true };
}

async function waitForUserList(captured, timeoutMs, log, label) {
  const before = captured.userList.length;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (captured.userList.length > before) {
      log(`${label}: userList fired (${captured.userList.length - before} new)`);
      return true;
    }
    await sleep(150);
  }
  log(`${label}: timeout — no new userList`);
  return false;
}

async function waitForUserListWith(captured, expected, timeoutMs, log, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = captured.userList.find((c) => {
      for (const [k, v] of Object.entries(expected)) {
        if ((c[k] ?? '') !== (v ?? '')) return false;
      }
      return true;
    });
    if (hit) {
      log(`${label}: userList matched ${JSON.stringify(expected)}`);
      return true;
    }
    await sleep(150);
  }
  log(`${label}: timeout — no userList matched ${JSON.stringify(expected)}`);
  return false;
}

async function scrollInfluencerTable(page, primitives) {
  // The real scroll container that drives userList pagination is
  // #page_content_wrap (sH > cH). The legacy .ant-table-body /
  // .ant-table-scroll selectors are kept as a fallback in case the
  // layout changes, but on current qly they have sH === cH.
  await primitives.evaluate(`(() => {
    const sc = document.getElementById('page_content_wrap');
    if (sc) { try { sc.scrollTop = sc.scrollHeight; } catch {} }
    const wrappers = [...document.querySelectorAll('.ant-table-body, .ant-table-scroll')];
    for (const w of wrappers) {
      try { w.scrollTop = w.scrollHeight; } catch {}
    }
  })()`);
}
