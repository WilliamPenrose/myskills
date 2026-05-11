// Bootstrap the runtime that drives qlydata's chrome session.
//
// Important: imports from `@site-use/runtime` top-level (PUBLIC API as of 0.1.1),
// NOT from `@site-use/runtime/internal/primitives`. The internal path still works
// but is reserved for site-use's own scripts.

import os from 'node:os';
import path from 'node:path';
import {
  createRuntime,
  createSecurePuppeteerPrimitives,
} from '@site-use/runtime';

/**
 * Build a runtime that shares the site-use chrome session.
 * Honors SITE_USE_DATA_DIR env (defaults to ~/.site-use), so site-use start +
 * qly skill use the same chrome profile + login cookies.
 */
export function createQlyRuntime() {
  const dataDir =
    process.env.SITE_USE_DATA_DIR || path.join(os.homedir(), '.site-use');
  return createRuntime({ config: { dataDir } });
}

export { createSecurePuppeteerPrimitives };
