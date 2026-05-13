// qly (qlydata.com) session-loss detector.
//
// Detects four manifestations of a logged-out / session-expired state
// observed in the wild:
//
//   1. URL redirected to /#/login (Vue Router intercept; happens
//      synchronously on reload OR ~100-200ms later as a delayed
//      router.push)
//   2. Modal rendered while URL stays on the original page. Two known
//      wordings:
//        - "登录状态已失效"            (older copy)
//        - "账号已在别处登录"          (kicked by another login on the
//          same credentials — current copy as of 2026-05)
//   3. Bare login form rendered (用户名/密码 textboxes visible)
//   4. Captcha challenge (slider puzzle "安全验证 / 拖动下方拼图完成验证")
//
// All AX-name checks are gated by an actual-visibility re-check, because
// qly pre-mounts the captcha slider offscreen (y≈-1000000 / opacity=0)
// and may do the same for other widgets. Pure name-match false-triggers
// SessionExpired on otherwise-healthy pages.
//
// Each check returns either null (session looks fine) or a string
// describing the specific failure mode — caller throws with
// "SessionExpired: <reason>" prefix so the batch layer can pattern-match
// on the prefix to abort the run.
//
// Two depth levels:
//   - checkSessionByUrl(page)             cheap, no CDP roundtrip
//   - checkSessionDeep({page, primitives}) takes a snapshot, covers all 4

const SIGNAL_DIALOG_LEGACY = '登录状态已失效';
const SIGNAL_DIALOG_KICKED = '账号已在别处登录';
const SIGNAL_LOGIN_FORM_USER = '请输入用户名';
const SIGNAL_LOGIN_FORM_PWD = '请输入密码';
const SIGNAL_CAPTCHA_TITLE = '安全验证';
const SIGNAL_CAPTCHA_INSTR = '拖动下方拼图完成验证';

// Returns true if any DOM text node containing one of `needles` belongs
// to an element that is actually rendered on screen. Walks text nodes
// (not querySelectorAll) so descendant-aggregated textContent does not
// cause every ancestor to match.
async function hasVisibleText(primitives, needles) {
  const expr = `(() => {
    const needles = ${JSON.stringify(needles)};
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = tw.nextNode())) {
      const t = node.nodeValue || '';
      if (!needles.some((s) => t.includes(s))) continue;
      const el = node.parentElement;
      if (!el) continue;
      if (typeof el.checkVisibility === 'function') {
        if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      }
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.bottom <= 0 || r.right <= 0) continue;
      if (r.top >= innerHeight || r.left >= innerWidth) continue;
      return true;
    }
    return false;
  })()`;
  return primitives.evaluate(expr);
}

export function checkSessionByUrl(page) {
  const url = page.url();
  if (url.includes('/#/login')) {
    return `redirected to ${url}`;
  }
  return null;
}

// Returns { reason, nodeCount }:
//   reason: string if session expired, null if it looks healthy
//   nodeCount: AX node count from the snapshot taken (0 if URL check
//     short-circuited before snapshotting). Useful as a diagnostic
//     value when the caller throws a non-SessionExpired error.
export async function checkSessionDeep({ page, primitives }) {
  const urlReason = checkSessionByUrl(page);
  if (urlReason) return { reason: urlReason, nodeCount: 0 };

  const sn = await primitives.takeSnapshot();
  const nodeCount = sn.idToNode.size;
  const names = [...sn.idToNode.values()]
    .map((n) => (typeof n.name === 'string' ? n.name : ''))
    .join('|');

  if (names.includes(SIGNAL_DIALOG_LEGACY) || names.includes(SIGNAL_DIALOG_KICKED)) {
    const dialogNeedles = [SIGNAL_DIALOG_LEGACY, SIGNAL_DIALOG_KICKED];
    if (await hasVisibleText(primitives, dialogNeedles)) {
      const hit = names.includes(SIGNAL_DIALOG_KICKED) ? SIGNAL_DIALOG_KICKED : SIGNAL_DIALOG_LEGACY;
      return { reason: `${hit} dialog visible`, nodeCount };
    }
  }
  if (names.includes(SIGNAL_LOGIN_FORM_USER) && names.includes(SIGNAL_LOGIN_FORM_PWD)) {
    if (await hasVisibleText(primitives, [SIGNAL_LOGIN_FORM_USER, SIGNAL_LOGIN_FORM_PWD])) {
      return { reason: 'login form rendered (用户名/密码 inputs)', nodeCount };
    }
  }
  if (names.includes(SIGNAL_CAPTCHA_TITLE) || names.includes(SIGNAL_CAPTCHA_INSTR)) {
    if (await hasVisibleText(primitives, [SIGNAL_CAPTCHA_TITLE, SIGNAL_CAPTCHA_INSTR])) {
      return { reason: 'captcha challenge (安全验证/拼图)', nodeCount };
    }
  }
  return { reason: null, nodeCount };
}

export async function assertSession({ page, primitives, deep = false }) {
  const reason = deep
    ? (await checkSessionDeep({ page, primitives })).reason
    : checkSessionByUrl(page);
  if (reason) throw new Error(`SessionExpired: ${reason}`);
}
