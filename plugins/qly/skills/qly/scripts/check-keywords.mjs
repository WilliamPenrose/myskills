// check-keywords.mjs — validate a keyword source file and print a summary.
//
// Used by onboarding to verify the user-supplied xlsx/csv before writing
// config. Single source of truth for column validation lives in
// _lib/keyword-source.mjs (also used by products.mjs at scrape time).
//
// Usage:
//   node check-keywords.mjs <path/to/keywords.xlsx>
//
// Exit codes:
//   0  ok, JSON summary printed to stdout
//   1  validation failed, human-readable message on stderr
//   2  argument error

import process from 'node:process';
import { existsSync } from 'node:fs';
import { inspectKeywords } from './_lib/keyword-source.mjs';

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node check-keywords.mjs <path/to/keywords.xlsx>');
    process.exit(2);
  }
  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }
  const info = await inspectKeywords(filePath);
  console.log(JSON.stringify(info, null, 2));
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
