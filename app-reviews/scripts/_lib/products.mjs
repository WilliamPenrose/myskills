import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir, ensureDataDir } from './paths.mjs';

const PRODUCTS_FILENAME = 'products.json';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXAMPLE_PATH = path.join(SKILL_DIR, 'products.example.json');

export function getProductsPath(dataDir) {
  return path.join(dataDir, PRODUCTS_FILENAME);
}

export function bootstrapIfMissing(dataDir) {
  const productsPath = getProductsPath(dataDir);
  if (fs.existsSync(productsPath)) return false;
  ensureDataDir(dataDir);
  let template;
  try {
    template = fs.readFileSync(EXAMPLE_PATH, 'utf8');
  } catch {
    template = JSON.stringify({
      _comment: 'Add your products below. Top-level keys (other than _comment) are canonical product names. Either play or ios may be omitted.',
      myapp: { aliases: ['my-app'], play: 'com.example.myapp', ios: '1234567890', default_country: 'us', default_lang: 'en' },
    }, null, 2) + '\n';
  }
  fs.writeFileSync(productsPath, template, 'utf8');
  return true;
}

export function loadProducts(dataDir) {
  const productsPath = getProductsPath(dataDir);
  const text = fs.readFileSync(productsPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`failed to parse ${productsPath}: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key.startsWith('_')) continue;
    if (!value || typeof value !== 'object') continue;
    // Note: a `default_lang` field on legacy product entries is silently
    // ignored. The fetch script no longer uses a per-product lang default;
    // Play requires explicit --lang, iOS does not use lang at all.
    out[key] = {
      canonical: key,
      aliases: Array.isArray(value.aliases) ? value.aliases.map((a) => String(a)) : [],
      play: typeof value.play === 'string' ? value.play : null,
      ios: value.ios !== undefined && value.ios !== null ? String(value.ios) : null,
      default_country: typeof value.default_country === 'string' ? value.default_country.toLowerCase() : 'us',
    };
  }
  return out;
}

export function buildLookup(products) {
  const map = new Map();
  for (const p of Object.values(products)) {
    map.set(p.canonical.toLowerCase(), p.canonical);
    for (const alias of p.aliases) {
      map.set(String(alias).toLowerCase(), p.canonical);
    }
  }
  return map;
}

export function resolveProduct(dataDir, name) {
  const products = loadProducts(dataDir);
  const productsPath = getProductsPath(dataDir);
  if (Object.keys(products).length === 0) {
    throw new Error(`products.json is empty at ${productsPath}. Add your products before running fetch/evaluate.`);
  }
  const lookup = buildLookup(products);
  const canonical = lookup.get(String(name).toLowerCase());
  if (!canonical) {
    const known = Object.values(products)
      .map((p) => `  ${p.canonical}${p.aliases.length ? ` (aliases: ${p.aliases.join(', ')})` : ''}`)
      .join('\n');
    throw new Error(`unknown product "${name}". Known products:\n${known}`);
  }
  return products[canonical];
}

export { resolveDataDir };
