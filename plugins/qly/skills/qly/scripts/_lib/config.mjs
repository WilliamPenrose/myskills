import { readFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';

/**
 * Load and validate config.yaml.
 * Throws with explanatory message if required fields are missing.
 */
export function loadConfig(configPath) {
  if (!existsSync(configPath)) {
    const err = new Error(`config.yaml not found at ${configPath} — run first-time setup`);
    err.code = 'CONFIG_MISSING';
    throw err;
  }
  const raw = yaml.load(readFileSync(configPath, 'utf8')) ?? {};

  if (!raw.keywords_source?.path) {
    throw new Error(`config.yaml at ${configPath} is missing keywords_source.path`);
  }
  if (!raw.filters?.price || !raw.filters?.live_sales) {
    throw new Error(`config.yaml at ${configPath} is missing filters.price or filters.live_sales`);
  }
  raw.influencer = {
    min_gmv: 1,
    window_days: 7,
    ...(raw.influencer ?? {}),
  };
  return raw;
}

/**
 * Load relevance.yaml. Returns object with thresholds, *_default, per_keyword.
 */
export function loadRelevance(relevancePath) {
  if (!existsSync(relevancePath)) {
    const err = new Error(`relevance.yaml not found at ${relevancePath} — run first-time setup`);
    err.code = 'RELEVANCE_MISSING';
    throw err;
  }
  const raw = yaml.load(readFileSync(relevancePath, 'utf8')) ?? {};
  raw.thresholds = { stage1: 0.55, stage2: 0.30, alpha: 0.4, ...(raw.thresholds ?? {}) };
  raw.positive_default = raw.positive_default ?? [];
  raw.negative_default = raw.negative_default ?? [];
  raw.per_keyword = raw.per_keyword ?? {};
  return raw;
}

/**
 * Build the (positives, negatives) tag lists for one keyword.
 * Matches the existing relevance-batch.mjs tagsFor() behavior exactly.
 */
export function tagsFor(cfg, keyword) {
  const ovr = cfg.per_keyword?.[keyword] ?? {};
  const positives = ovr.positive ?? [
    ...(cfg.positive_default ?? []),
    ...(ovr.positive_extra ?? []),
  ];
  const negatives = ovr.negative ?? [
    ...(cfg.negative_default ?? []),
    ...(ovr.negative_extra ?? []),
  ];
  return {
    positives: [...new Set(positives)],
    negatives: [...new Set(negatives)],
  };
}
