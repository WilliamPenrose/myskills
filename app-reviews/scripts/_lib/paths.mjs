import * as fs from 'node:fs';
import * as path from 'node:path';

const DATA_DIR_NAME = '.app-reviews';

function findUpwards(startDir, predicate) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (predicate(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function dirExists(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

export function resolveDataDir({ flagValue } = {}) {
  if (flagValue) return path.resolve(flagValue);
  if (process.env.APP_REVIEWS_DATA_DIR) return path.resolve(process.env.APP_REVIEWS_DATA_DIR);

  const cwd = process.cwd();

  const existingDataDir = findUpwards(cwd, (d) => dirExists(path.join(d, DATA_DIR_NAME)));
  if (existingDataDir) return path.join(existingDataDir, DATA_DIR_NAME);

  const gitRoot = findUpwards(cwd, (d) => dirExists(path.join(d, '.git')));
  if (gitRoot) return path.join(gitRoot, DATA_DIR_NAME);

  return path.join(cwd, DATA_DIR_NAME);
}

export function ensureDataDir(dataDir) {
  const created = !dirExists(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });

  if (created) {
    const parent = path.dirname(dataDir);
    const inGitRepo = findUpwards(parent, (d) => dirExists(path.join(d, '.git'))) !== null;
    if (inGitRepo) {
      const gitignorePath = path.join(dataDir, '.gitignore');
      if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, '*\n', 'utf8');
      }
    }
  }
  return dataDir;
}
