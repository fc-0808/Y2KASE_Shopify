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

// Fetch all products with full variant data
const allProducts = [];
let url = `${BASE}/products.json?limit=250&fields=id,title,variants`;
while (url) {
  const r    = await fetch(url, { headers: { 'X-Shopify-Access-Token': TOKEN } });
  const link = r.headers.get('link') || '';
  const { products } = await r.json();
  allProducts.push(...(products || []));
  const next = link.match(/<([^>]+)>;\s*rel="next"/);
  url = next ? next[1] : null;
  if (url) await sleep(300);
}

console.log(`\nChecking ${allProducts.length} products for zero-stock variants...\n`);

let soldOutProducts = 0;
for (const p of allProducts) {
  const zeroQtyVariants = p.variants.filter(v => v.inventory_quantity <= 0);
  const wrongPolicy     = p.variants.filter(v => v.inventory_policy !== 'continue');
  const allZero         = p.variants.every(v => v.inventory_quantity <= 0);

  if (zeroQtyVariants.length > 0 || wrongPolicy.length > 0) {
    soldOutProducts++;
    console.log(`[${soldOutProducts}] ${p.title.slice(0, 60)}`);
    console.log(`  Total variants: ${p.variants.length} | Zero-qty variants: ${zeroQtyVariants.length} | Wrong policy: ${wrongPolicy.length} | All zero: ${allZero}`);
    if (wrongPolicy.length > 0) {
      wrongPolicy.slice(0, 3).forEach(v => console.log(`  WRONG POLICY: variant ${v.id} | policy: ${v.inventory_policy} | qty: ${v.inventory_quantity}`));
    }
    zeroQtyVariants.slice(0, 3).forEach(v => console.log(`  zero-qty: variant ${v.id} | policy: ${v.inventory_policy} | qty: ${v.inventory_quantity}`));
  }
}

if (soldOutProducts === 0) {
  console.log('✅ All products have positive stock and correct inventory policies!');
} else {
  console.log(`\n⚠️  ${soldOutProducts} products have zero-qty or wrong-policy variants`);
}
