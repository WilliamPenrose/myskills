// probe.mjs — read-only inspection of the live qly chrome session.
//
// Use when you (or an LLM agent) need to see what's actually on the
// page: diagnose UI drift, confirm captcha/login state, capture an AX
// snapshot for selector hunting.
//
// Does NOT click, type, or assert session. Safe to run while another
// qly script is paused. Writes a snapshot JSON to .qlydata/snapshots/
// and prints a one-line summary to stdout.
//
// Usage:
//   node scripts/probe.mjs                          # inspect current active qly tab
//   node scripts/probe.mjs --url <url>              # navigate first, then inspect
//   node scripts/probe.mjs --name <slug>            # control output filename
//   node scripts/probe.mjs --screenshot             # also save PNG
//   node scripts/probe.mjs --no-snapshot            # skip JSON dump (summary only)
//   node scripts/probe.mjs --data-dir <path>        # override .qlydata/ location

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { resolveDataDir, dataDirPaths } from './_lib/paths.mjs';
import { createQlyRuntime, createSecurePuppeteerPrimitives } from './_lib/bootstrap.mjs';

const TARGET_HOST = 'qlydata.com';

const SESSION_SIGNALS = {
  dialog_legacy: '登录状态已失效',
  dialog_kicked: '账号已在别处登录',
  login_user: '请输入用户名',
  login_pwd: '请输入密码',
  captcha_title: '安全验证',
  captcha_instr: '拖动下方拼图完成验证',
  quota_banner: '今日访问次数已达上限',
};

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--data-dir') out.dataDir = argv[++i];
    else if (a === '--screenshot') out.screenshot = true;
    else if (a === '--no-snapshot') out.noSnapshot = true;
    else if (a === '-h' || a === '--help') out.help = true;
  }
  return out;
}

function slugifyUrl(url) {
  try {
    const u = new URL(url);
    const hash = u.hash.replace(/^#\/?/, '').split('?')[0];
    if (hash) return hash.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'probe';
    const p = u.pathname.replace(/^\/+|\/+$/g, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    return p || 'probe';
  } catch {
    return 'probe';
  }
}

function timestamp() {
  const t = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
}

async function pickQlyPage(browser) {
  const pages = await browser.pages();
  for (const p of pages) {
    try {
      if (p.url().includes(TARGET_HOST)) return p;
    } catch { /* ignore */ }
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('node scripts/probe.mjs [--url <url>] [--name <slug>] [--screenshot] [--no-snapshot] [--data-dir <path>]');
    return;
  }

  const dataDir = resolveDataDir({ cliFlag: args.dataDir });
  const dirs = dataDirPaths(dataDir);
  mkdirSync(dirs.snapshots, { recursive: true });

  const runtime = createQlyRuntime();
  const browser = await runtime.ensureBrowser({ autoLaunch: true });

  let page = await pickQlyPage(browser);
  if (!page && args.url) {
    page = await browser.newPage();
  } else if (!page) {
    console.error('[probe] no qly tab open, and no --url supplied. Open qlydata.com in chrome, or pass --url.');
    process.exit(1);
  }

  if (args.url) {
    console.error(`[probe] navigating to ${args.url}`);
    await page.goto(args.url, { waitUntil: 'domcontentloaded' });
  }

  await page.bringToFront();
  const url = page.url();
  const title = await page.title().catch(() => '');

  const primitives = createSecurePuppeteerPrimitives({
    page,
    throttle: { minDelay: 0, maxDelay: 0 },
  });

  const sn = await primitives.takeSnapshot();
  const nodes = [...sn.idToNode.values()];
  const nodeCount = nodes.length;

  const signalHits = {};
  for (const [k, needle] of Object.entries(SESSION_SIGNALS)) {
    signalHits[k] = nodes.some((n) => typeof n.name === 'string' && n.name.includes(needle));
  }

  const slug = args.name || slugifyUrl(url);
  const ts = timestamp();

  let snapshotPath = null;
  if (!args.noSnapshot) {
    snapshotPath = path.join(dirs.snapshots, `${slug}-${ts}.json`);
    const dump = {
      probedAt: new Date().toISOString(),
      url,
      title,
      nodeCount,
      signalHits,
      nodes: nodes.map((n) => ({
        uid: n.uid,
        role: n.role,
        name: n.name,
        value: n.value,
        children: n.children,
        frameUrl: n.frameUrl,
      })),
    };
    writeFileSync(snapshotPath, JSON.stringify(dump, null, 2));
  }

  let screenshotPath = null;
  if (args.screenshot) {
    screenshotPath = path.join(dirs.snapshots, `${slug}-${ts}.png`);
    const b64 = await primitives.screenshot();
    writeFileSync(screenshotPath, Buffer.from(b64, 'base64'));
  }

  const hitsList = Object.entries(signalHits)
    .filter(([, v]) => v)
    .map(([k]) => k);

  console.log(JSON.stringify({
    url,
    title,
    nodeCount,
    signalHits: hitsList,
    snapshotPath,
    screenshotPath,
  }, null, 2));
}

main().catch((err) => {
  console.error(`[probe] ${err.stack || err.message || err}`);
  process.exit(1);
});
