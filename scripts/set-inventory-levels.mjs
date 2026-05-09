/**
 * Y2KASE — Force inventory-level refresh via inventory_levels/set.json
 *
 * Sets every inventory item to a fixed positive quantity (3) at the store's
 * fulfillment location. This takes a completely different API code path than
 * variant updates and guarantees Shopify recomputes + invalidates the
 * storefront availability cache for every product.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
function loadEnv(f) {
  let t = readFileSync(f, 'utf8'); if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  for (const line of t.split(/\r?\n/)) { const s = line.trim(); if (!s || s.startsWith('#')) continue; const eq = s.indexOf('='); if (eq === -1) continue; process.env[s.slice(0, eq).trim()] = s.slice(eq + 1).trim(); }
}
loadEnv(resolve(__dirname, '../.env'));

const SHOP    = process.env.SHOPIFY_SHOP;
const TOKEN   = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const VER     = process.env.SHOPIFY_API_VERSION || '2026-04';
const BASE    = `https://${SHOP}/admin/api/${VER}`;
const sleep   = ms => new Promise(r => setTimeout(r, ms));

const get  = async (p) => { const r = await fetch(`${BASE}${p}`, { headers: { 'X-Shopify-Access-Token': TOKEN } }); return r.json(); };
const post = async (p, b) => {
  const r = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(b),
  });
  await sleep(250);
  return r.json();
};

// Find the fulfillment location ID from an existing inventory level
console.log('Finding fulfillment location...');
const firstProduct = await get('/products.json?limit=1&fields=variants');
const firstItemId  = firstProduct.products[0].variants[0].inventory_item_id;
const levelsRes    = await get(`/inventory_levels.json?inventory_item_ids=${firstItemId}`);
const locationId   = levelsRes.inventory_levels?.[0]?.location_id;
if (!locationId) {
  console.error('Could not find location ID. Aborting.');
  process.exit(1);
}
console.log(`Using location: ${locationId}\n`);

// Fetch all products and collect inventory_item_ids for variants that have shopify tracking
console.log('Fetching all products...');
const allProducts = [];
let url = `${BASE}/products.json?limit=250&fields=id,title,variants`;
while (url) {
  const r    = await fetch(url, { headers: { 'X-Shopify-Access-Token': TOKEN } });
  const link = r.headers.get('link') || '';
  const { products } = await r.json();
  allProducts.push(...(products || []));
  const next = link.match(/<([^>]+)>;\s*rel="next"/);
  url = next ? next[1] : null;
  if (url) await sleep(250);
}

// Collect inventory items that are tracked by Shopify AND have qty <= 0
const itemsToSet = [];
for (const p of allProducts) {
  for (const v of p.variants) {
    // Only set inventory for shopify-tracked variants with qty <= 0
    if (v.inventory_management === 'shopify' && v.inventory_quantity <= 0) {
      itemsToSet.push({ inventory_item_id: v.inventory_item_id, product_title: p.title.slice(0, 40) });
    }
  }
}

console.log(`Found ${itemsToSet.length} tracked zero-stock variants to refill to qty=3\n`);

let success = 0, errors = 0;
for (let i = 0; i < itemsToSet.length; i++) {
  const { inventory_item_id, product_title } = itemsToSet[i];
  process.stdout.write(`  [${i + 1}/${itemsToSet.length}] Setting qty=3 for item ${inventory_item_id} (${product_title})\r`);

  const res = await post('/inventory_levels/set.json', {
    location_id: locationId,
    inventory_item_id,
    available: 3,
  });

  if (res.inventory_level) {
    success++;
  } else {
    console.error(`\n  ❌ Error for item ${inventory_item_id}:`, JSON.stringify(res).slice(0, 120));
    errors++;
  }
}

if (itemsToSet.length === 0) {
  console.log('No zero-stock tracked variants found — inventory is already at positive levels.');
  console.log('The "Sold out" badges may be a CDN cache issue. Please wait a few minutes and refresh.');
} else {
  console.log(`\n\n══ DONE ══════════════════════════════════════════════════════`);
  console.log(`  Inventory levels set to 3:  ${success} variants`);
  console.log(`  Errors:                     ${errors}`);
  console.log(`\n  Verify at: https://y2kase.com/collections/all\n`);
}
