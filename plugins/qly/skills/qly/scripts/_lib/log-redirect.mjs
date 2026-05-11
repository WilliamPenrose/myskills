// Redirect process.stderr to .dev/.logs/<scriptName>.log so long-running
// batch scripts don't flood the terminal. Stdout (final summary) stays on
// the terminal. The returned `term` helper writes a line directly to the
// real terminal stderr (bypassing the redirect) for progress heartbeats.
//
// Usage at the top of a batch script:
//   import { redirectStderrToLog } from '../_lib/log-redirect.mjs';
//   const { term } = redirectStderrToLog('influencer-batch');
//   term('[batch] starting');             // -> terminal AND log
//   console.error('[infl] noisy step');   // -> log only

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function redirectStderrToLog(scriptName) {
  const here = path.dirname(fileURLToPath(import.meta.url));   // .dev/scripts/_lib
  const logDir = path.resolve(here, '..', '..', '.logs');      // .dev/.logs
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${scriptName}.log`);
  const fd = fs.openSync(logPath, 'w');                        // truncate

  const realStderr = process.stderr.write.bind(process.stderr);

  process.stderr.write = (chunk, encOrCb, cb) => {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    fs.writeSync(fd, buf);
    if (typeof encOrCb === 'function') encOrCb();
    else if (typeof cb === 'function') cb();
    return true;
  };

  function term(msg) {
    const s = typeof msg === 'string' ? msg : String(msg);
    realStderr(s.endsWith('\n') ? s : s + '\n');
    fs.writeSync(fd, Buffer.from(s.endsWith('\n') ? s : s + '\n'));
  }

  realStderr(`[log] verbose -> ${logPath}\n`);
  fs.writeSync(fd, Buffer.from(`[log] starting at ${new Date().toISOString()}\n`));

  return { logPath, term };
}
