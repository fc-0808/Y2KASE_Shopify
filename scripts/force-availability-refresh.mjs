/**
 * Y2KASE — Force Storefront Availability Refresh
 *
 * Shopify's storefront CDN can cache `variant.available = false` even after
 * inventory_policy has been updated to 'continue' via the Admin API.
 * This script "touches" every variant by re-sending inventory_policy='continue',
 * forcing Shopify to recompute and bust the storefront cache for each product.
 *
 * Usage:
 *   node scripts/force-availability-refresh.mjs
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const get = async (p) => {
  const r = await fetch(`${BASE}${p}`, { headers: { 'X-Shopify-Access-Token': TOKEN } });
  return r.json();
};
const put = async (p, b) => {
  const r = await fetch(`${BASE}${p}`, {
    method: 'PUT',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(b),
  });
  await sleep(500);
  return r.json();
};

// ── Fetch all products ────────────────────────────────────────────────────────
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
  if (url) await sleep(500);
}
console.log(`Found ${allProducts.length} products\n`);

// ── Force-touch each product to bust storefront cache ────────────────────────
let updated = 0, errors = 0;
for (let i = 0; i < allProducts.length; i++) {
  const p = allProducts[i];
  process.stdout.write(`  [${String(i + 1).padStart(3)}/${allProducts.length}] ${p.title.slice(0, 55)}\r`);

  // Re-apply inventory_policy='continue' on all variants to force a cache bust
  const variants = p.variants.map(v => ({
    id: v.id,
    inventory_policy: 'continue',
    inventory_management: 'shopify',
  }));

  const result = await put(`/products/${p.id}.json`, {
    product: { id: p.id, variants },
  });

  if (result.product) {
    updated++;
  } else {
    console.error(`\n  ❌ Error on "${p.title.slice(0, 40)}":`, result.errors || JSON.stringify(result).slice(0, 120));
    errors++;
  }
}

console.log(`\n\n══ DONE ══════════════════════════════════════════════════════`);
console.log(`  Products refreshed: ${updated}`);
console.log(`  Errors:             ${errors}`);
console.log(`\n  Shopify will recompute storefront availability within ~30 seconds.`);
console.log(`  Verify at: https://y2kase.com/collections/all\n`);
