/**
 * Y2KASE — Force Full Storefront Index Rebuild
 *
 * Shopify maintains a separate "published storefront index" that controls what
 * product.available / variant.available return in Liquid and the product .js endpoints.
 * This index is NOT always updated by variant-level Admin API calls.
 *
 * The only reliable way to force a full rebuild is to set the product status
 * to 'draft' (unpublish) then immediately back to 'active' (republish).
 * This triggers Shopify's product publishing pipeline which rebuilds the
 * complete storefront index for each product.
 *
 * NOTE: Prefer graphql-republish.mjs over this script — it uses the GraphQL
 * productSet mutation (2026-04 recommended) and avoids REST product write endpoints
 * which are deprecated. This file retains the REST approach for legacy reference only.
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
const VERSION = process.env.SHOPIFY_API_VERSION || '2026-04';
const BASE    = `https://${SHOP}/admin/api/${VERSION}`;
const sleep   = ms => new Promise(r => setTimeout(r, ms));

const put = async (p, b) => {
  const r = await fetch(`${BASE}${p}`, {
    method: 'PUT',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(b),
  });
  await sleep(600);
  return r.json();
};

// Fetch all products
console.log('Fetching all products...');
const allProducts = [];
let url = `${BASE}/products.json?limit=250&fields=id,title,status,published_at`;
while (url) {
  const r    = await fetch(url, { headers: { 'X-Shopify-Access-Token': TOKEN } });
  const link = r.headers.get('link') || '';
  const { products } = await r.json();
  allProducts.push(...(products || []));
  const next = link.match(/<([^>]+)>;\s*rel="next"/);
  url = next ? next[1] : null;
  if (url) await sleep(600);
}
console.log(`Found ${allProducts.length} products\n`);

let published = 0, errors = 0;

for (let i = 0; i < allProducts.length; i++) {
  const p = allProducts[i];
  process.stdout.write(`  [${String(i + 1).padStart(3)}/${allProducts.length}] ${p.title.slice(0, 50)}\r`);

  // Step 1: Set to draft (unpublish from Online Store)
  const draftRes = await put(`/products/${p.id}.json`, {
    product: { id: p.id, status: 'draft', published_at: null },
  });

  if (!draftRes.product) {
    console.error(`\n  ❌ Draft failed for "${p.title.slice(0, 40)}":`, JSON.stringify(draftRes).slice(0, 100));
    errors++;
    continue;
  }

  // Small pause to ensure draft state registers
  await sleep(400);

  // Step 2: Set back to active (republish)
  const activeRes = await put(`/products/${p.id}.json`, {
    product: { id: p.id, status: 'active', published_at: new Date().toISOString() },
  });

  if (activeRes.product) {
    published++;
  } else {
    console.error(`\n  ❌ Republish failed for "${p.title.slice(0, 40)}":`, JSON.stringify(activeRes).slice(0, 100));
    errors++;
  }
}

console.log(`\n\n══ DONE ══════════════════════════════════════════════════════`);
console.log(`  Products republished: ${published}`);
console.log(`  Errors:               ${errors}`);
console.log(`\n  Shopify is rebuilding the storefront index. Allow 60–120 seconds.`);
console.log(`  Then verify at: https://y2kase.com/collections/all`);
console.log(`  Expected: ALL products show "Sale" badge with active Add to Cart buttons\n`);
