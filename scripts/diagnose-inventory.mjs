import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
function loadEnv(f) {
  let t = readFileSync(f, 'utf8'); if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  for (const line of t.split(/\r?\n/)) { const s = line.trim(); if (!s || s.startsWith('#')) continue; const eq = s.indexOf('='); if (eq === -1) continue; process.env[s.slice(0,eq).trim()] = s.slice(eq+1).trim(); }
}
loadEnv(resolve(__dirname, '../.env'));
const SHOP=process.env.SHOPIFY_SHOP, TOKEN=process.env.SHOPIFY_ADMIN_ACCESS_TOKEN, VER=process.env.SHOPIFY_API_VERSION||'2025-04';
const BASE=`https://${SHOP}/admin/api/${VER}`;
const get = async (p) => { const r = await fetch(`${BASE}${p}`, {headers:{'X-Shopify-Access-Token':TOKEN}}); return r.json(); };

// Get locations
const locsRes = await get('/locations.json');
console.log('\n=== LOCATIONS ===');
(locsRes.locations||[]).forEach(l => console.log(`  [${l.active?'active':'inactive'}] ${l.id} — ${l.name}`));

// Get one product's full variant data
const prodRes = await get('/products.json?limit=1&fields=id,title,variants');
const p = prodRes.products[0];
const v = p.variants[0];
console.log('\n=== FIRST PRODUCT ===');
console.log('Title:', p.title);
console.log('\nFirst variant:');
console.log('  id:', v.id);
console.log('  inventory_item_id:', v.inventory_item_id);
console.log('  inventory_management:', v.inventory_management);
console.log('  inventory_policy:', v.inventory_policy);
console.log('  inventory_quantity:', v.inventory_quantity);
console.log('  price:', v.price);
console.log('  compare_at_price:', v.compare_at_price);

// Get inventory levels for this item
const levelsRes = await get(`/inventory_levels.json?inventory_item_ids=${v.inventory_item_id}`);
console.log('\n=== INVENTORY LEVELS ===');
(levelsRes.inventory_levels||[]).forEach(l => console.log(`  location ${l.location_id}: available=${l.available}, on_hand=${l.quantities}`));

// Summary across all products
const allProds = await get('/products.json?limit=250&fields=id,title,variants');
const stats = { total:0, soldOut:0, tracked:0, untracked:0, noPolicy:0, denyPolicy:0, continuePolicy:0 };
for (const prod of allProds.products) {
  for (const va of prod.variants) {
    stats.total++;
    if (va.inventory_quantity <= 0) stats.soldOut++;
    if (va.inventory_management === 'shopify') stats.tracked++;
    else stats.untracked++;
    if (va.inventory_policy === 'deny') stats.denyPolicy++;
    else if (va.inventory_policy === 'continue') stats.continuePolicy++;
    else stats.noPolicy++;
  }
}
console.log('\n=== VARIANT SUMMARY ===');
Object.entries(stats).forEach(([k,v]) => console.log(`  ${k}: ${v}`));
