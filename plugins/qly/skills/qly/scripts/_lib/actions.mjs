// qlydata-actions.mjs — shared helpers for Stage 2 actions on
// qlydata.com/#/market_rank/goods/goods_search.
//
// Each exported helper is independent: it takes its own pre-snapshot
// (so it tolerates DOM drift after a previous step's commit), performs
// the action via primitives.click/type, takes a post-snapshot, runs
// its own verification, and returns { success, ...uids }.
//
// Helpers do NOT write to disk — callers (per-action scripts and the
// pipeline orchestrator) format JSON output. Exception: `triggerExport`
// MUST manage the download dir itself (CDP setDownloadBehavior, watch for
// new file, rename) — that's the whole point of the helper.

import fs from 'node:fs';
import path from 'node:path';

import { cascadeConfirm } from './cascade-confirm.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cold-start guard: when products.mjs (or ensureGoodsSearchTab) navigates
// to goods_search, page.goto resolves on domcontentloaded — the Vue app
// hasn't mounted, so the price/sales/search controls aren't in AX yet.
// First action then trips TargetsNotFound, diagnoseAndRethrow runs, and
// the keyword gets recorded as a spurious failure. Poll until the three
// filter-bar anchors are all present before continuing.
//
// Anchors must agree with setPriceRange / setLivestreamSales / searchKeyword:
//   - button "平均到手价" with uid < 1500
//   - button "销量"       with uid < 1500
//   - textbox "请输入商品关键词或商品链接"
export async function waitForFilterBar(primitives, {
  timeoutMs = 15000,
  pollMs = 400,
  log = (m) => console.error(`[wait-filter-bar] ${m}`),
} = {}) {
  const TEXTBOX_NAME = '请输入商品关键词或商品链接';
  const deadline = Date.now() + timeoutMs;
  let lastMissing = null;
  while (Date.now() < deadline) {
    const sn = await primitives.takeSnapshot();
    const nodes = [...sn.idToNode.values()];
    const hasPrice = nodes.some((n) => n.role === 'button' && n.name === '平均到手价' && Number(n.uid) < 1500);
    const hasSales = nodes.some((n) => n.role === 'button' && n.name === '销量' && Number(n.uid) < 1500);
    const hasSearch = nodes.some((n) => n.role === 'textbox' && n.name === TEXTBOX_NAME);
    if (hasPrice && hasSales && hasSearch) return { success: true };
    lastMissing = { hasPrice, hasSales, hasSearch };
    await sleep(pollMs);
  }
  log(`timed out after ${timeoutMs}ms missing=${JSON.stringify(lastMissing)}`);
  return { success: false, reason: 'FilterBarNotRendered', missing: lastMissing };
}

export function lowestUidByPredicate(idToNode, predicate) {
  let lowest = null;
  for (const n of idToNode.values()) {
    if (predicate(n)) {
      if (lowest === null || Number(n.uid) < Number(lowest)) lowest = n.uid;
    }
  }
  return lowest;
}

export function findParent(idToNode, childUid) {
  for (const n of idToNode.values()) {
    if ((n.children || []).includes(childUid)) return n;
  }
  return null;
}

export async function clearFocusedInput(primitives) {
  await primitives.evaluate(`(() => {
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  })()`);
}

// In the 销量 popover, rows render as adjacent uids: StaticText "<metric>:"
// at uid N, then button "不限"/value at uid N+1. The StaticText is often
// a tree orphan, so use uid adjacency rather than parent traversal.
export function findTabSwitcher(idToNode, labelText, log = () => {}) {
  const labels = [...idToNode.values()]
    .filter((n) => n.role === 'StaticText' && n.name === labelText)
    .sort((a, b) => Number(a.uid) - Number(b.uid));
  log(`StaticText "${labelText}" candidates: ${labels.map((c) => c.uid).join(',')}`);
  for (const label of labels) {
    for (let off = 1; off <= 5; off++) {
      const candUid = String(Number(label.uid) + off);
      const cand = idToNode.get(candUid);
      if (cand && cand.role === 'button') {
        log(`picked tab switcher uid=${candUid} (label=${label.uid}, off=${off})`);
        return candUid;
      }
    }
  }
  return null;
}

// Per-row 确 定 button (with space, commits typed values for ONE row) sits
// at the InlineTextBox just after max spinbutton. Walk parents to nearest
// button ancestor.
export function findRowConfirm(idToNode, maxSpinbuttonUid, log = () => {}) {
  const itx = idToNode.get(String(Number(maxSpinbuttonUid) + 1));
  if (!itx || itx.name !== '确 定') {
    log(`expected InlineTextBox "确 定" at uid ${Number(maxSpinbuttonUid) + 1}, got ${JSON.stringify(itx)}`);
    return null;
  }
  let cur = itx.uid;
  for (let depth = 0; depth < 10; depth++) {
    const parent = findParent(idToNode, cur);
    if (!parent) break;
    if (parent.role === 'button') {
      log(`row 确 定 button uid=${parent.uid} (anchor itx=${itx.uid}, depth=${depth + 1})`);
      return parent.uid;
    }
    cur = parent.uid;
  }
  log(`no button ancestor for InlineTextBox "确 定" uid=${itx.uid}`);
  return null;
}

// Outer .ant-popover footer: 重置 / 取消 / 确定 (no space) at three
// consecutive AX uids. Other page-level 重置 buttons exist but only the
// search_more footer has all three at uid N, N+1, N+2.
export function findOuterConfirm(idToNode, log = () => {}) {
  const resets = [...idToNode.values()]
    .filter((n) => n.role === 'button' && n.name === '重置')
    .sort((a, b) => Number(a.uid) - Number(b.uid));
  for (const reset of resets) {
    const cancel = idToNode.get(String(Number(reset.uid) + 1));
    if (!cancel || cancel.role !== 'button' || cancel.name !== '取消') continue;
    const confirm = idToNode.get(String(Number(reset.uid) + 2));
    if (!confirm || confirm.role !== 'button' || confirm.name !== '确定') continue;
    log(`outer footer trio: 重置=${reset.uid} 取消=${cancel.uid} 确定=${confirm.uid}`);
    return confirm.uid;
  }
  log('no outer 重置/取消/确定 trio with consecutive uids');
  return null;
}

export async function setPriceRange(primitives, { min, max, log = (m) => console.error(`[price] ${m}`) } = {}) {
  log('step 1: open 平均到手价 popover');
  const pre = await primitives.takeSnapshot();

  // Idempotency: if a chip already shows 平均到手价 with the target range,
  // skip all click/type work. Same regex used at the end for verification.
  const targetRe = new RegExp(`平均到手价[　\\s]*[：:][　\\s]*${min}\\s*[-~–—到至]\\s*${max}`);
  const alreadySet = [...pre.idToNode.values()].some(
    (n) => typeof n.name === 'string' && targetRe.test(n.name),
  );
  if (alreadySet) {
    log(`already set: chip matches "平均到手价：${min}-${max}" — skipping`);
    return { success: true, idempotent: true, postSnapshot: pre };
  }

  const triggerUid = lowestUidByPredicate(pre.idToNode,
    (n) => n.role === 'button' && n.name === '平均到手价' && Number(n.uid) < 1500);
  if (!triggerUid) {
    log('平均到手价 trigger not found');
    return { success: false, reason: 'TriggerNotFound' };
  }
  log(`click 平均到手价 uid=${triggerUid}`);
  await primitives.click(triggerUid);
  await sleep(800);

  const sn1 = await primitives.takeSnapshot();
  const spinbuttons = [...sn1.idToNode.values()]
    .filter((n) => n.role === 'spinbutton')
    .map((n) => n.uid)
    .sort((a, b) => Number(a) - Number(b));
  if (spinbuttons.length < 2) {
    log('Need 2 spinbuttons');
    return { success: false, reason: 'SpinbuttonsMissing', triggerUid };
  }
  const minUid = spinbuttons[0];
  const maxUid = spinbuttons[1];
  log(`min=${minUid} max=${maxUid}`);

  log(`step 3a: clear+type "${min}" into ${minUid}`);
  await primitives.click(minUid); await sleep(150);
  await clearFocusedInput(primitives); await sleep(80);
  await primitives.type(minUid, String(min), { delay: 60 }); await sleep(200);

  log(`step 3b: clear+type "${max}" into ${maxUid}`);
  await primitives.click(maxUid); await sleep(150);
  await clearFocusedInput(primitives); await sleep(80);
  await primitives.type(maxUid, String(max), { delay: 60 }); await sleep(200);

  log('step 4: cascade confirm');
  const clickedUids = await cascadeConfirm(primitives, { log: (m) => log(`cascade ${m}`) });
  log(`cascade clicked ${clickedUids.length} button(s): ${clickedUids.join(',')}`);

  await sleep(800);
  const post = await primitives.takeSnapshot();
  const postNodes = [...post.idToNode.values()];
  const re = new RegExp(`${min}\\s*[-~–—到至]\\s*${max}`);
  const success = postNodes.some(
    (n) => typeof n.name === 'string' && re.test(n.name),
  );

  return {
    success,
    triggerUid, minUid, maxUid, clickedUids,
    postSnapshot: post,
  };
}

export async function setLivestreamSales(primitives, { min, max, log = (m) => console.error(`[sales] ${m}`) } = {}) {
  log('step 1: snapshot, decide whether to open popover');
  const pre = await primitives.takeSnapshot();

  // Idempotency: chip already shows 直播销量 with the target range → skip.
  const targetRe = new RegExp(`直播销量[　\\s]*[：:][　\\s]*${min}\\s*[-~–—到至]\\s*${max}`);
  const alreadySet = [...pre.idToNode.values()].some(
    (n) => typeof n.name === 'string' && targetRe.test(n.name),
  );
  if (alreadySet) {
    log(`already set: chip matches "直播销量：${min}-${max}" — skipping`);
    return { success: true, idempotent: true, postSnapshot: pre };
  }

  const popoverAlreadyOpen = [...pre.idToNode.values()].some(
    (n) => n.role === 'StaticText' && n.name === '直播销量:',
  );
  let xiaoliangUid = null;
  if (popoverAlreadyOpen) {
    log('popover already open — skipping click 销量 trigger');
  } else {
    xiaoliangUid = lowestUidByPredicate(pre.idToNode,
      (n) => n.role === 'button' && n.name === '销量' && Number(n.uid) < 1500);
    if (!xiaoliangUid) {
      log('销量 trigger not found');
      return { success: false, reason: 'TriggerNotFound' };
    }
    log(`click 销量 uid=${xiaoliangUid}`);
    await primitives.click(xiaoliangUid);
    await sleep(800);
  }

  log('step 2: locate 直播销量 tab switcher');
  const sn1 = popoverAlreadyOpen ? pre : await primitives.takeSnapshot();
  const tabUid = findTabSwitcher(sn1.idToNode, '直播销量:', log);
  if (!tabUid) {
    log('直播销量 tab switcher not found');
    return { success: false, reason: 'TabNotFound', xiaoliangUid };
  }
  log(`click 直播销量 tab uid=${tabUid}`);
  await primitives.click(tabUid);
  await sleep(800);

  log('step 3: locate spinbuttons');
  const sn2 = await primitives.takeSnapshot();
  const spinbuttons = [...sn2.idToNode.values()]
    .filter((n) => n.role === 'spinbutton')
    .map((n) => n.uid)
    .sort((a, b) => Number(a) - Number(b));
  if (spinbuttons.length < 2) {
    log('Need 2 spinbuttons');
    return { success: false, reason: 'SpinbuttonsMissing', xiaoliangUid, tabUid };
  }
  const minUid = spinbuttons[0];
  const maxUid = spinbuttons[1];
  log(`min=${minUid} max=${maxUid}`);

  log(`step 4a: focus+clear min ${minUid}, type "${min}"`);
  await primitives.click(minUid); await sleep(150);
  await clearFocusedInput(primitives); await sleep(80);
  await primitives.type(minUid, String(min), { delay: 60 }); await sleep(200);

  log(`step 4b: focus+clear max ${maxUid}, type "${max}"`);
  await primitives.click(maxUid); await sleep(150);
  await clearFocusedInput(primitives); await sleep(80);
  await primitives.type(maxUid, String(max), { delay: 60 }); await sleep(200);

  log('step 5a: locate per-row 确 定');
  const sn3 = await primitives.takeSnapshot();
  const confirmUid = findRowConfirm(sn3.idToNode, maxUid, log);
  if (!confirmUid) {
    log('Per-row 确 定 not found');
    return { success: false, reason: 'PerRowConfirmNotFound', xiaoliangUid, tabUid, minUid, maxUid };
  }
  log(`click per-row 确 定 ${confirmUid}`);
  await primitives.click(confirmUid);
  await sleep(800);

  log('step 5b: locate outer footer 确定');
  const sn4 = await primitives.takeSnapshot();
  const outerConfirmUid = findOuterConfirm(sn4.idToNode, log);
  if (!outerConfirmUid) {
    log('Outer footer 确定 not found');
    return { success: false, reason: 'OuterConfirmNotFound', xiaoliangUid, tabUid, minUid, maxUid, confirmUid };
  }
  log(`click outer 确定 ${outerConfirmUid}`);
  await primitives.click(outerConfirmUid);
  await sleep(2500);

  log('step 6: post snapshot');
  const post = await primitives.takeSnapshot();
  const postNodes = [...post.idToNode.values()];
  const re = new RegExp(`${min}\\s*[-~–—到至]\\s*${max}`);
  const success = postNodes.some(
    (n) => typeof n.name === 'string'
      && n.name.includes('直播销量')
      && re.test(n.name),
  );

  return {
    success,
    xiaoliangUid, tabUid, minUid, maxUid, confirmUid, outerConfirmUid,
    postSnapshot: post,
  };
}

export async function searchKeyword(primitives, { keyword, log = (m) => console.error(`[search] ${m}`) } = {}) {
  const TEXTBOX_NAME = '请输入商品关键词或商品链接';
  const SEARCH_BUTTON_NAME = '图标: search';

  log('pre-action snapshot');
  const pre = await primitives.takeSnapshot();

  // Idempotency: if any textbox already holds the exact keyword as its value,
  // search has already been done. AX `value` may or may not be exposed by the
  // snapshot — falsy comparison → no short-circuit → safe fallback to normal
  // flow when value isn't available.
  const alreadySet = [...pre.idToNode.values()].some(
    (n) => n.role === 'textbox' && typeof n.value === 'string' && n.value === keyword,
  );
  if (alreadySet) {
    log(`already set: textbox value === "${keyword}" — skipping`);
    return { success: true, idempotent: true, keyword, postSnapshot: pre };
  }

  let textboxUid = null;
  for (const node of pre.idToNode.values()) {
    if (node.role === 'textbox' && node.name === TEXTBOX_NAME) {
      textboxUid = node.uid;
      break;
    }
  }
  let searchUid = null;
  for (const node of pre.idToNode.values()) {
    if (node.role === 'button' && node.name === SEARCH_BUTTON_NAME) {
      if (searchUid === null || Number(node.uid) < Number(searchUid)) searchUid = node.uid;
    }
  }
  if (!textboxUid || !searchUid) {
    log(`targets not found: textboxUid=${textboxUid} searchUid=${searchUid}`);
    return { success: false, reason: 'TargetsNotFound', textboxUid, searchUid };
  }
  log(`textbox uid=${textboxUid}  search uid=${searchUid}`);

  log(`click textbox ${textboxUid}`);
  await primitives.click(textboxUid);
  await sleep(150);
  await clearFocusedInput(primitives);
  await sleep(80);
  log(`type "${keyword}"`);
  await primitives.type(textboxUid, keyword, { delay: 60 });
  await sleep(200);

  log(`click search ${searchUid}`);
  await primitives.click(searchUid);
  await sleep(2500);

  log('post-action snapshot');
  const post = await primitives.takeSnapshot();
  const postNodes = [...post.idToNode.values()];
  let urlAfter = '';
  try { urlAfter = post.url ?? ''; } catch { /* takeSnapshot may not include url */ }
  if (!urlAfter) {
    try {
      urlAfter = await primitives.evaluate(`location.href`);
    } catch { urlAfter = ''; }
  }
  const decodedUrl = (() => { try { return decodeURIComponent(urlAfter); } catch { return urlAfter; } })();
  const urlOk = decodedUrl.includes(keyword);
  const nodeOk = postNodes.some((n) => typeof n.name === 'string' && n.name.includes(keyword));
  // valueOk: textbox carries the typed value — proves the type+submit happened
  // even if the keyword returned 0 rows (so name/URL don't echo it back).
  const valueOk = postNodes.some(
    (n) => n.role === 'textbox' && typeof n.value === 'string' && n.value === keyword,
  );
  const success = valueOk || urlOk || nodeOk;

  return {
    success,
    textboxUid, searchUid,
    keyword,
    urlAfter, urlOk, nodeOk, valueOk,
    postSnapshot: post,
  };
}

// Click the 导 出 (with space) button next to 配置列表项 in the filter bar,
// wait for Chrome to land an .xlsx into the controlled downloadDir, rename
// it to filenamePattern, and return the final path.
//
// Why `page` is required: Chrome download path is set via CDP, not a JS API.
// We open a fresh CDPSession on this page and call Page.setDownloadBehavior
// to redirect downloads into our project-scoped dir, regardless of the
// browser profile's default. Effect is page-scoped — user's other tabs are
// unaffected.
//
// filenamePattern supports {stamp} placeholder. Default: 'qlydata-{stamp}.xlsx'.
export async function triggerExport(primitives, {
  page,
  downloadDir,
  filenamePattern = 'qlydata-{stamp}.xlsx',
  log = (m) => console.error(`[export] ${m}`),
  pollIntervalMs = 500,
  pollTimeoutMs = 30000,
  stableMs = 800,
} = {}) {
  if (!page) return { success: false, reason: 'PageMissing' };
  if (!downloadDir) return { success: false, reason: 'DownloadDirMissing' };

  fs.mkdirSync(downloadDir, { recursive: true });

  log(`set download path -> ${downloadDir}`);
  const cdp = await page.target().createCDPSession();
  await cdp.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDir,
  });

  // Snapshot existing filenames so we can detect the new one.
  const baseline = new Set(fs.readdirSync(downloadDir));
  log(`baseline file count: ${baseline.size}`);

  // Locate 导 出 button — name is "导 出" with a space (like "确 定").
  // Two such buttons exist (inner + M2 wrapper); take the lowest uid.
  log('pre-click snapshot');
  const sn = await primitives.takeSnapshot();
  let exportUid = null;
  for (const node of sn.idToNode.values()) {
    if (node.role === 'button' && node.name === '导 出') {
      if (exportUid === null || Number(node.uid) < Number(exportUid)) exportUid = node.uid;
    }
  }
  if (!exportUid) {
    log('导 出 button not found');
    return { success: false, reason: 'ExportButtonNotFound' };
  }
  log(`click 导 出 uid=${exportUid}`);
  await primitives.click(exportUid);

  // Poll for a new .xlsx to appear (and for any .crdownload partial to
  // disappear). Once a candidate is stable for stableMs, we consider the
  // download finished.
  const start = Date.now();
  let chosen = null;
  while (Date.now() - start < pollTimeoutMs) {
    await sleep(pollIntervalMs);
    const current = fs.readdirSync(downloadDir);
    const partials = current.filter((n) => n.endsWith('.crdownload'));
    const newXlsx = current.filter((n) => n.toLowerCase().endsWith('.xlsx') && !baseline.has(n));
    if (partials.length > 0) {
      log(`download in progress: ${partials.join(',')}`);
      continue;
    }
    if (newXlsx.length === 0) continue;
    // Pick the most-recently modified new xlsx.
    const sorted = newXlsx.map((n) => ({
      name: n,
      mtimeMs: fs.statSync(path.join(downloadDir, n)).mtimeMs,
    })).sort((a, b) => b.mtimeMs - a.mtimeMs);
    const top = sorted[0];
    if (Date.now() - top.mtimeMs >= stableMs) {
      chosen = top;
      break;
    }
  }

  if (!chosen) {
    log('download timeout — no new .xlsx settled within budget');
    return { success: false, reason: 'DownloadTimeout', exportUid };
  }
  log(`detected new file: ${chosen.name}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const finalName = filenamePattern.replace('{stamp}', stamp);
  const oldPath = path.join(downloadDir, chosen.name);
  const newPath = path.join(downloadDir, finalName);
  fs.renameSync(oldPath, newPath);
  log(`renamed: ${chosen.name} -> ${finalName}`);

  return {
    success: true,
    exportUid,
    originalName: chosen.name,
    filePath: newPath,
    sizeBytes: fs.statSync(newPath).size,
  };
}
