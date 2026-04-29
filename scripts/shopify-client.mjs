/**
 * Shared Shopify Admin API client
 * Uses fetch (built-in Node 18+) with credentials from .env
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env manually (avoids extra deps in scripts)
function loadEnv() {
  try {
    const envPath = resolve(__dirname, '../.env');
    const lines = readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [key, ...rest] = trimmed.split('=');
      process.env[key.trim()] = rest.join('=').trim();
    }
  } catch {
    // .env not found — rely on real environment variables
  }
}

loadEnv();

const STORE =
  process.env.SHOPIFY_SHOP?.trim() || process.env.SHOPIFY_STORE?.trim();
const TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN?.trim();
const VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';

if (!STORE || !TOKEN) {
  console.error(
    'Missing SHOPIFY_SHOP (or SHOPIFY_STORE) or SHOPIFY_ADMIN_ACCESS_TOKEN in .env. Run npm run refresh-token if using client credentials.'
  );
  process.exit(1);
}

export const BASE_URL = `https://${STORE}/admin/api/${VERSION}`;

export async function shopifyFetch(endpoint, options = {}) {
  const url = `${BASE_URL}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': TOKEN,
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify API error ${res.status}: ${body}`);
  }

  return res.json();
}
