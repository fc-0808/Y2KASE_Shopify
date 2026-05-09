/**
 * Force-publish all products via GraphQL productUpdate mutation.
 * Sets status: ACTIVE explicitly, which triggers the full
 * Shopify publication pipeline including storefront index rebuild.
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
const VER   = process.env.SHOPIFY_API_VERSION || '2026-04';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const gql = async (query, variables = {}) => {
  const r = await fetch(`https://${SHOP}/admin/api/${VER}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  await sleep(400);
  return r.json();
};

// Get all product IDs
console.log('Fetching product IDs...');
let allProducts = [];
let cursor = null, hasNext = true;
while (hasNext) {
  const res = await gql(`query($cursor: String) {
    products(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges { node { id title } }
    }
  }`, { cursor });
  if (res.errors) { console.error('Error:', res.errors[0].message); break; }
  allProducts.push(...res.data.products.edges.map(e => e.node));
  hasNext = res.data.products.pageInfo.hasNextPage;
  cursor = res.data.products.pageInfo.endCursor;
  if (hasNext) await sleep(400);
}
console.log(`Found ${allProducts.length} products\n`);

// Use productUpdate to set status: ACTIVE on each product
// This triggers Shopify's full publication pipeline
let updated = 0, errors = 0;
for (let i = 0; i < allProducts.length; i++) {
  const { id, title } = allProducts[i];
  process.stdout.write(`  [${String(i + 1).padStart(3)}/${allProducts.length}] ${title.slice(0, 55)}\r`);

  // First set to draft
  const draftRes = await gql(`
    mutation($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id status }
        userErrors { field message }
      }
    }
  `, { input: { id, status: 'DRAFT' } });

  const draftErrs = draftRes.data?.productUpdate?.userErrors || [];
  if (draftRes.errors || draftErrs.length > 0) {
    const msg = draftRes.errors?.[0]?.message || draftErrs[0]?.message;
    console.error(`\n  Draft error: ${title.slice(0, 30)}: ${msg}`);
    errors++;
    continue;
  }

  await sleep(300);

  // Then set back to active
  const activeRes = await gql(`
    mutation($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id status }
        userErrors { field message }
      }
    }
  `, { input: { id, status: 'ACTIVE' } });

  const activeErrs = activeRes.data?.productUpdate?.userErrors || [];
  if (activeRes.errors || activeErrs.length > 0) {
    const msg = activeRes.errors?.[0]?.message || activeErrs[0]?.message;
    console.error(`\n  Active error: ${title.slice(0, 30)}: ${msg}`);
    errors++;
  } else {
    updated++;
  }
}

console.log(`\n\n══ DONE ══════════════════════════════════════════════════════`);
console.log(`  Products activated via GraphQL: ${updated}`);
console.log(`  Errors:                          ${errors}`);
console.log(`\n  Allow 2 minutes for Shopify to rebuild storefront index.`);
console.log(`  Verify at: https://y2kase.com/collections/all\n`);
