/**
 * Force-touch all collections to bust Shopify's page_cache.
 * A no-op update on each collection causes Shopify to recompute its
 * internal cache hash, invalidating all product-grid pages.
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

const SHOP  = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const VER   = process.env.SHOPIFY_API_VERSION || '2025-04';
const BASE  = `https://${SHOP}/admin/api/${VER}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const get = async (p) => { const r = await fetch(`${BASE}${p}`, { headers: { 'X-Shopify-Access-Token': TOKEN } }); return r.json(); };
const put = async (p, b) => {
  const r = await fetch(`${BASE}${p}`, {
    method: 'PUT',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(b),
  });
  await sleep(300);
  return r.json();
};

const [smartRes, customRes] = await Promise.all([
  get('/smart_collections.json?limit=250&fields=id,title,handle'),
  get('/custom_collections.json?limit=250&fields=id,title,handle'),
]);

const smartCols  = smartRes.smart_collections  || [];
const customCols = customRes.custom_collections || [];

console.log(`Found ${smartCols.length} smart + ${customCols.length} custom collections\n`);

let updated = 0, errors = 0;

// Touch smart collections
for (const col of smartCols) {
  process.stdout.write(`  [smart] ${col.title.slice(0, 50)}\r`);
  const res = await put(`/smart_collections/${col.id}.json`, {
    smart_collection: { id: col.id, published: true },
  });
  if (res.smart_collection) updated++;
  else { console.error(`\n  Error: ${col.title}`, JSON.stringify(res).slice(0, 80)); errors++; }
}

// Touch custom collections
for (const col of customCols) {
  process.stdout.write(`  [custom] ${col.title.slice(0, 50)}\r`);
  const res = await put(`/custom_collections/${col.id}.json`, {
    custom_collection: { id: col.id, published: true },
  });
  if (res.custom_collection) updated++;
  else { console.error(`\n  Error: ${col.title}`, JSON.stringify(res).slice(0, 80)); errors++; }
}

console.log(`\n\n══ DONE ══════════════════════════════════════════════════════`);
console.log(`  Collections updated: ${updated}`);
console.log(`  Errors:              ${errors}`);
console.log(`\n  Shopify will rebuild collection pages within ~30 seconds.`);
console.log(`  Verify at: https://y2kase.com/collections/all\n`);
