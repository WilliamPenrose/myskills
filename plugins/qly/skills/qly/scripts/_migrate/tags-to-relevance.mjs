// One-time migration: old tags.yaml structure -> new relevance.yaml structure.
//
// Old (.dev/docs/qlydata/tags.yaml):
//   positive_default: [...]
//   negative_default: [...]
//   per_keyword:
//     name:
//       negative_extra: [...]
//
// New (.qlydata/relevance.yaml) — adds a thresholds block, preserves the rest verbatim.
//
// Usage:
//   node tags-to-relevance.mjs --in tags.yaml --out relevance.yaml

import { readFileSync, writeFileSync } from 'node:fs';
import yaml from 'js-yaml';

const DEFAULT_THRESHOLDS = { stage1: 0.55, stage2: 0.30, alpha: 0.4 };

export function transformTags(input) {
  return {
    thresholds: { ...DEFAULT_THRESHOLDS, ...(input.thresholds ?? {}) },
    positive_default: input.positive_default ?? [],
    negative_default: input.negative_default ?? [],
    per_keyword: input.per_keyword ?? {},
  };
}

export function runMigration(inputPath, outputPath) {
  const input = yaml.load(readFileSync(inputPath, 'utf8')) ?? {};
  const out = transformTags(input);
  writeFileSync(outputPath, yaml.dump(out, { lineWidth: -1, noRefs: true }));
  console.log(`Wrote ${outputPath}`);
  return out;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--in') out.in = argv[++i];
    else if (argv[i] === '--out') out.out = argv[++i];
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const args = parseArgs(process.argv);
  if (!args.in || !args.out) {
    console.error('Usage: node tags-to-relevance.mjs --in <tags.yaml> --out <relevance.yaml>');
    process.exit(2);
  }
  runMigration(args.in, args.out);
}
