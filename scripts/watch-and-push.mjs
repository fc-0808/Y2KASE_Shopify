/**
 * Watches .env for a new token, then auto-pushes all theme files.
 * Run this, then update your token — it fires the push automatically.
 */
import { readFileSync, watchFile } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath   = resolve(__dirname, '../.env');
const ROOT      = resolve(__dirname, '..');
const THEME     = '143640854605';
const sleep     = ms => new Promise(r => setTimeout(r, ms));

function readEnv() {
  let t = readFileSync(envPath, 'utf8');
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  const env = {};
  for (const line of t.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq === -1) continue;
    env[s.slice(0, eq).trim()] = s.slice(eq + 1).trim();
  }
  return env;
}

const filesToPush = [
  'assets/y2kase.css',
  'layout/theme.liquid',
  'blocks/_product-card-gallery.liquid',
  'blocks/buy-buttons.liquid',
];

async function testAndPush(token, shop, ver) {
  const BASE = `https://${shop}/admin/api/${ver}`;

  // Test write_themes by trying to read a known asset
  const testRes = await fetch(`${BASE}/themes/${THEME}/assets.json?asset[key]=assets/y2kase.css`, {
    headers: { 'X-Shopify-Access-Token': token },
  });
  if (testRes.status !== 200) {
    console.log('  Token cannot read themes — skipping push');
    return false;
  }

  // Test write by attempting a no-op PUT on a tiny asset
  const testAsset = await testRes.json();
  const writeTest = await fetch(`${BASE}/themes/${THEME}/assets.json`, {
    method: 'PUT',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ asset: { key: 'assets/y2kase.css', value: testAsset.asset.value } }),
  });
  const writeResult = await writeTest.json();
  if (writeResult.errors) {
    console.log('  ⚠️  Token still lacks write_themes — waiting for token with correct scopes...');
    return false;
  }

  console.log('\n  ✅ write_themes scope confirmed! Pushing all files...\n');
  let ok = 0, errors = 0;
  for (const file of filesToPush) {
    const value = readFileSync(resolve(ROOT, file), 'utf8');
    const r = await fetch(`${BASE}/themes/${THEME}/assets.json`, {
      method: 'PUT',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ asset: { key: file, value } }),
    });
    await sleep(500);
    const d = await r.json();
    if (d.asset) {
      console.log(`  ✅ ${file}`);
      ok++;
    } else {
      console.error(`  ❌ ${file}:`, JSON.stringify(d).slice(0, 120));
      errors++;
    }
  }
  console.log(`\n══════════════════════════════════════════════════════════`);
  console.log(`  Pushed: ${ok}  |  Errors: ${errors}`);
  console.log(`\n  ✨ Done! Check https://y2kase.com to see your changes.\n`);
  return true;
}

let lastToken = readEnv().SHOPIFY_ADMIN_ACCESS_TOKEN;

console.log(`
╔══════════════════════════════════════════════════════════╗
║     Y2KASE — Auto Theme Push Watcher                     ║
╚══════════════════════════════════════════════════════════╝

Watching .env for a new token with write_themes scope...

DO THIS NOW (2 minutes):
  1. Go to: https://y2kase-1435.myshopify.com/admin/settings/apps/development
  2. Click "Cursor Dev"
  3. Click "Configuration" tab
  4. Click "Edit" next to Admin API scopes
  5. Scroll down and ENABLE "write_themes"
  6. Click Save
  7. Go to "API credentials" tab
  8. Click "Reinstall app" (or "Update" if shown)
  9. Copy the new Admin API access token
 10. Open .env in Cursor and paste as SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_...
 11. Save .env — this watcher fires automatically!

Waiting...`);

watchFile(envPath, { interval: 1000 }, async () => {
  const env = readEnv();
  const newToken = env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  if (!newToken || newToken === lastToken) return;
  lastToken = newToken;
  console.log(`\n  🔑 New token detected (${newToken.slice(0, 12)}...) — testing scopes...`);
  const done = await testAndPush(newToken, env.SHOPIFY_SHOP, env.SHOPIFY_API_VERSION || '2025-04');
  if (done) process.exit(0);
});
