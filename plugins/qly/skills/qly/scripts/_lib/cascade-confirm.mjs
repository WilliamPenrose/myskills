// cascadeConfirm — click visible commit buttons from innermost popover outward,
// re-snapshotting between each click, until none remain (or maxLayers reached).
//
// Generalizes the qlydata stage2 pattern: per-row confirm + outer popover footer
// confirm. Works for any UI where multi-layer popovers each render their own
// commit button (Ant Design, Element Plus, plain dialogs).
//
// Key heuristics:
//   * "Innermost popover" = the visible popper container with the highest
//     z-index among (self + ancestors). Newer popovers are stacked on top.
//   * "Visible" = aria-hidden!=true, display!=none, visibility!=hidden, rect>0.
//   * Map DOM commit element -> AX uid by sorting AX role:button with the
//     matching name by uid asc, then taking the same DOM-tree-order index.
//   * Dedup AX wrapper buttons (e.g. M2 layers an outer button over a real
//     <button> child with the same name) — keep only leaf-most buttons so
//     the count matches DOM-visible elements.
//
// Read-only: uses primitives.evaluate for DOM queries; all clicks via
// primitives.click(uid). See feedback_evaluate_readonly.md.

const DEFAULT_POPPER_SEL =
  '.ant-popover, .ant-dropdown, .el-popper, .el-popover, [role="dialog"], [role="tooltip"]';
const DEFAULT_CONFIRM_TEXTS = [
  '确定', '确 定', '确认',
  'OK', 'Apply', '应用', 'Submit', '提交', '保存', 'Save',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Click commit buttons in nested popovers, innermost first.
 * @returns {Promise<string[]>} uids that were clicked, in click order
 */
export async function cascadeConfirm(primitives, opts = {}) {
  const {
    confirmTexts = DEFAULT_CONFIRM_TEXTS,
    popperSel = DEFAULT_POPPER_SEL,
    maxLayers = 4,
    settleMs = 700,
    log = (m) => console.error(`[cascade] ${m}`),
  } = opts;
  const clicked = [];
  for (let layer = 0; layer < maxLayers; layer++) {
    const sn = await primitives.takeSnapshot();
    const uid = await locateInnermostPopperConfirm(
      primitives, sn.idToNode, confirmTexts, popperSel, log,
    );
    if (!uid) {
      log(`layer ${layer}: no popover-scoped commit visible; done`);
      return clicked;
    }
    log(`layer ${layer}: click uid=${uid}`);
    await primitives.click(uid);
    clicked.push(uid);
    await sleep(settleMs);
  }
  log(`reached maxLayers=${maxLayers}; stopping (may be a stuck popover)`);
  return clicked;
}

async function locateInnermostPopperConfirm(primitives, idToNode, confirmTexts, popperSel, log) {
  const located = await primitives.evaluate(`(() => {
    const POPPER_SEL = ${JSON.stringify(popperSel)};
    const TEXTS = ${JSON.stringify(confirmTexts)};
    function isVisible(el) {
      if (!el) return false;
      if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    function ownText(el) {
      let t = '';
      for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
      return t.trim();
    }
    function popperOf(el) {
      let cur = el.parentElement;
      while (cur) {
        if (cur.matches && cur.matches(POPPER_SEL)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    function maxZIndex(el) {
      let z = 0;
      let cur = el;
      while (cur) {
        const cs = getComputedStyle(cur);
        if (cs.position && cs.position !== 'static') {
          const v = parseInt(cs.zIndex || '0', 10);
          if (Number.isFinite(v) && v > z) z = v;
        }
        cur = cur.parentElement;
      }
      return z;
    }
    // Collect visible commit-text elements that live inside a visible popper.
    // Only EXACT own-text matches (no descendant text) so we hit the
    // <span>label</span> leaf, not the parent button.
    const candidates = [];
    for (const el of document.querySelectorAll('*')) {
      const text = ownText(el);
      if (!TEXTS.includes(text)) continue;
      if (!isVisible(el)) continue;
      const popper = popperOf(el);
      if (!popper || !isVisible(popper)) continue;
      candidates.push({ el, popper, text });
    }
    if (candidates.length === 0) return null;
    // Pick the candidate whose popper has the highest z-index (innermost).
    let best = candidates[0];
    let bestZ = maxZIndex(best.popper);
    for (let i = 1; i < candidates.length; i++) {
      const z = maxZIndex(candidates[i].popper);
      if (z > bestZ) { best = candidates[i]; bestZ = z; }
    }
    // DOM tree-order index of best.el among ALL visible elements with the
    // same own-text (whether in a popper or not). AX role:button name=text
    // ordering follows DOM order, so this index lets us pick the right uid.
    const sameText = [];
    for (const el of document.querySelectorAll('*')) {
      if (ownText(el) !== best.text) continue;
      if (!isVisible(el)) continue;
      sameText.push(el);
    }
    return {
      text: best.text,
      domIndex: sameText.indexOf(best.el),
      sameTextCount: sameText.length,
      bestZ,
    };
  })()`);
  if (!located || located.domIndex < 0) return null;
  // AX side: collect role:button with name === text, drop wrappers (any node
  // whose subtree contains another candidate node), sort by uid asc, pick by
  // domIndex.
  const all = [...idToNode.values()].filter(
    (n) => n.role === 'button' && n.name === located.text,
  );
  const allUids = new Set(all.map((n) => n.uid));
  const isWrapperOfAnother = (n) => {
    const stack = [...(n.children || [])];
    const seen = new Set();
    while (stack.length) {
      const u = stack.pop();
      if (seen.has(u)) continue;
      seen.add(u);
      if (allUids.has(u)) return true;
      const child = idToNode.get(u);
      if (child && child.children) stack.push(...child.children);
    }
    return false;
  };
  const leaves = all.filter((n) => !isWrapperOfAnother(n))
    .sort((a, b) => Number(a.uid) - Number(b.uid));
  log(`text="${located.text}" domIndex=${located.domIndex} ` +
      `(DOM visible=${located.sameTextCount}, AX leaf buttons=${leaves.length}, popper z=${located.bestZ})`);
  const picked = leaves[located.domIndex];
  if (!picked) {
    log(`no AX leaf at domIndex ${located.domIndex} — DOM/AX count mismatch`);
    return null;
  }
  return picked.uid;
}
