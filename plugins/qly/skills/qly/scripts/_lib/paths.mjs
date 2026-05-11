// Resolve where .qlydata/ lives. Mirrors app-reviews/_lib/paths.mjs.
//
// Resolution order:
//   1. --data-dir <path> CLI flag
//   2. QLY_DATA_DIR env var
//   3. nearest .qlydata/ walking up from cwd
//   4. <git_root>/.qlydata/ if cwd is inside a git repo
//   5. <cwd>/.qlydata/ as final fallback

import { existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

function tryGitRoot(cwd) {
  try {
    const root = execSync('git rev-parse --show-toplevel', { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    return root || null;
  } catch {
    return null;
  }
}

function walkUpFor(cwd, name) {
  let dir = path.resolve(cwd);
  while (true) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function resolveDataDir({ cliFlag, env = process.env, cwd = process.cwd() } = {}) {
  if (cliFlag) return path.resolve(cliFlag);
  if (env.QLY_DATA_DIR) return path.resolve(env.QLY_DATA_DIR);

  const existing = walkUpFor(cwd, '.qlydata');
  if (existing) return existing;

  const gitRoot = tryGitRoot(cwd);
  if (gitRoot) return path.join(gitRoot, '.qlydata');

  return path.join(path.resolve(cwd), '.qlydata');
}

export function dataDirPaths(dataDir) {
  return {
    root:           dataDir,
    config:         path.join(dataDir, 'config.yaml'),
    relevance:      path.join(dataDir, 'relevance.yaml'),
    db:             path.join(dataDir, 'qlydata.db'),
    exports:        path.join(dataDir, 'exports'),
    tasks:          path.join(dataDir, 'tasks'),
    tasksDone:      path.join(dataDir, 'tasks', 'done'),
    snapshots:      path.join(dataDir, 'snapshots'),
    logs:           path.join(dataDir, '.logs'),
    gitignore:      path.join(dataDir, '.gitignore'),
  };
}
