/**
 * Deep audit of all product metadata: tags, types, handles, variants, images
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../.env');

function loadEnv(filePath) {
  let text = readFileSync(filePath, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    process.env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
}

loadEnv(envPath);

const SHOP    = process.env.SHOPIFY_SHOP;
const TOKEN   = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const VERSION = process.env.SHOPIFY_API_VERSION || '2025-04';
const BASE    = `https://${SHOP}/admin/api/${VERSION}`;
const GQL_URL = `${BASE}/graphql.json`;

async function rest(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' }
  });
  return res.json();
}

async function gql(query) {
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query }),
  });
  return res.json();
}

const [productsRes, collectionsRes, categoriesRes] = await Promise.all([
  rest('/products.json?limit=250&fields=id,title,handle,tags,product_type,vendor,variants,images,status,created_at,updated_at'),
  rest('/collections.json?limit=50'),
  gql(`{
    shop {
      productTags(first: 100) { edges { node } }
    }
    collections(first: 50) {
      nodes {
        id title handle
        productsCount { count }
        sortOrder
        ruleSet { rules { column relation condition } }
      }
    }
  }`)
]);

const products = productsRes.products;
const collections = categoriesRes.data?.collections?.nodes ?? [];
const allTags = categoriesRes.data?.shop?.productTags?.edges?.map(e => e.node) ?? [];

console.log('\n══════════════════════════════════════════════════════');
console.log('  Y2KASE PRODUCT METADATA DEEP AUDIT');
console.log('══════════════════════════════════════════════════════');

// All tags used across products
const tagCounts = {};
for (const p of products) {
  const tags = p.tags ? p.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
  for (const t of tags) {
    tagCounts[t] = (tagCounts[t] || 0) + 1;
  }
}

console.log('\n── ALL TAGS (sorted by frequency) ──────────────────');
const sortedTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);
for (const [tag, count] of sortedTags) {
  console.log(`  [${count}x] ${tag}`);
}

console.log('\n── PRODUCT TYPES ────────────────────────────────────');
const types = new Set(products.map(p => p.product_type).filter(Boolean));
if (types.size === 0) console.log('  ⚠️  None set');
else for (const t of types) console.log(`  • ${t}`);

console.log('\n── VENDORS ──────────────────────────────────────────');
const vendors = new Set(products.map(p => p.vendor).filter(Boolean));
for (const v of vendors) console.log(`  • ${v}`);

console.log('\n── COLLECTIONS ──────────────────────────────────────');
if (collections.length === 0) {
  console.log('  ⚠️  No collections exist');
} else {
  for (const c of collections) {
    const smart = c.ruleSet ? 'SMART' : 'MANUAL';
    console.log(`  [${smart}] ${c.title} (${c.handle}) — ${c.productsCount?.count ?? 0} products`);
    if (c.ruleSet?.rules?.length) {
      for (const r of c.ruleSet.rules) {
        console.log(`    rule: ${r.column} ${r.relation} "${r.condition}"`);
      }
    }
  }
}

console.log('\n── VARIANT STRUCTURE (all products) ─────────────────');
const allOptions = new Set();
for (const p of products) {
  for (const v of p.variants) {
    allOptions.add(v.title);
  }
}
console.log(`  Total unique variant titles: ${allOptions.size}`);
const sampleOptions = [...allOptions].slice(0, 20);
for (const o of sampleOptions) console.log(`  • ${o}`);

console.log('\n── IMAGE COUNT PER PRODUCT ──────────────────────────');
for (const p of products) {
  const imgs = p.images?.length ?? 0;
  const flag = imgs < 3 ? '⚠️ ' : '✅ ';
  console.log(`  ${flag}[${imgs} imgs] ${p.title.slice(0, 60)}`);
}

console.log('\n── FULL TAG LIST (all unique) ───────────────────────');
console.log(sortedTags.map(([t]) => t).join(', '));
