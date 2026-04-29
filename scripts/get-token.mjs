/**
 * Exchange Dev Dashboard client credentials for a short-lived Admin API token
 * and write it to SHOPIFY_ADMIN_ACCESS_TOKEN in .env
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../.env');

function loadEnvFile(filePath) {
  let text = readFileSync(filePath, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    process.env[key] = value;
  }
}

loadEnvFile(envPath);

const shop = process.env.SHOPIFY_SHOP?.trim();
const clientId = process.env.SHOPIFY_CLIENT_ID?.trim();
const clientSecret = process.env.SHOPIFY_CLIENT_SECRET?.trim();

if (!shop || !clientId || !clientSecret) {
  console.error(
    'Missing SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, or SHOPIFY_CLIENT_SECRET in .env'
  );
  process.exit(1);
}

async function main() {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    }),
  });

  const raw = await res.text().catch(() => '');
  let data = {};
  try { data = JSON.parse(raw); } catch { /* non-JSON body */ }

  if (!data.access_token) {
    console.error(`HTTP ${res.status} ${res.statusText}`);
    console.error('Response body:', raw || '(empty)');
    console.error('\nCommon causes:');
    console.error('  • App not installed on the store — go to the Dev Dashboard and install it on y2kase-1435.myshopify.com');
    console.error('  • Wrong CLIENT_ID or CLIENT_SECRET');
    console.error('  • App does not support client_credentials grant (only custom/merchant-owned apps do)');
    process.exit(1);
  }

  let env = readFileSync(envPath, 'utf8');
  if (/^SHOPIFY_ADMIN_ACCESS_TOKEN=/m.test(env)) {
    env = env.replace(
      /^SHOPIFY_ADMIN_ACCESS_TOKEN=.*/m,
      `SHOPIFY_ADMIN_ACCESS_TOKEN=${data.access_token}`
    );
  } else {
    env = `${env.trimEnd()}\nSHOPIFY_ADMIN_ACCESS_TOKEN=${data.access_token}\n`;
  }
  writeFileSync(envPath, env, 'utf8');

  console.log('SHOPIFY_ADMIN_ACCESS_TOKEN updated in .env (refresh before expiry).');
}

main();
