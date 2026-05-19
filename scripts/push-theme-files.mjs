/**
 * Push specific theme files to the live Horizon theme (143640854605).
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
const THEME   = '143640854605'; // live Horizon theme
const BASE    = `https://${SHOP}/admin/api/${VER}`;
const ROOT    = resolve(__dirname, '..');
const sleep   = ms => new Promise(r => setTimeout(r, ms));

const filesToPush = [
  'assets/y2kase.css',
  'layout/theme.liquid',
  'sections/etsy-welcome-funnel.liquid',
  'templates/page.welcome.json',
];

async function pushFile(key) {
  const localPath = resolve(ROOT, key.replace(/\//g, '/'));
  const value = readFileSync(localPath, 'utf8');

  const r = await fetch(`${BASE}/themes/${THEME}/assets.json`, {
    method: 'PUT',
    headers: {
      'X-Shopify-Access-Token': TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ asset: { key, value } }),
  });
  await sleep(500);
  return r.json();
}

console.log(`Pushing ${filesToPush.length} files to live theme ${THEME}...\n`);

let ok = 0, errors = 0;
for (const file of filesToPush) {
  process.stdout.write(`  Pushing: ${file}\r`);
  const res = await pushFile(file);
  if (res.asset) {
    console.log(`  ✅ ${file} (updated_at: ${res.asset.updated_at})`);
    ok++;
  } else {
    console.error(`  ❌ ${file}:`, JSON.stringify(res).slice(0, 200));
    errors++;
  }
}

console.log(`\n══ DONE ══════════════════════════════════════════════════════`);
console.log(`  Files pushed:  ${ok}`);
console.log(`  Errors:        ${errors}`);
console.log(`\n  Verify at: https://y2kase.com/collections/all`);
console.log(`  Expected: "Sale" badges on all discounted products\n`);
