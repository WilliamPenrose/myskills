import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const DATA_DIR = path.join(os.homedir(), '.claude', 'data', 'app-reviews');
const PRODUCTS_PATH = path.join(DATA_DIR, 'products.json');

const EMPTY_TEMPLATE = {
  _comment: 'Add your products below. Top-level keys (other than _comment) are canonical product names. Aliases are matched case-insensitively. Either play or ios may be omitted.',
  myapp: {
    aliases: ['my-app', 'ma'],
    play: 'com.example.myapp',
    ios: '1234567890',
    default_country: 'us',
    default_lang: 'en',
  },
};

export function getProductsPath() {
  return PRODUCTS_PATH;
}

export function bootstrapIfMissing() {
  if (fs.existsSync(PRODUCTS_PATH)) return false;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(EMPTY_TEMPLATE, null, 2) + '\n', 'utf8');
  return true;
}

export function loadProducts() {
  const text = fs.readFileSync(PRODUCTS_PATH, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`failed to parse ${PRODUCTS_PATH}: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key.startsWith('_')) continue;
    if (!value || typeof value !== 'object') continue;
    out[key] = {
      canonical: key,
      aliases: Array.isArray(value.aliases) ? value.aliases.map((a) => String(a)) : [],
      play: typeof value.play === 'string' ? value.play : null,
      ios: value.ios !== undefined && value.ios !== null ? String(value.ios) : null,
      default_country: typeof value.default_country === 'string' ? value.default_country.toLowerCase() : 'us',
      default_lang: typeof value.default_lang === 'string' ? value.default_lang.toLowerCase() : 'en',
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

export function resolveProduct(name) {
  const products = loadProducts();
  if (Object.keys(products).length === 0) {
    throw new Error(`products.json is empty at ${PRODUCTS_PATH}. Add your products before running fetch/evaluate.`);
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
