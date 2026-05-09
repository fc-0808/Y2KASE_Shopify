/**
 * Force-publish all products via Admin GraphQL productUpdate mutation.
 * This takes a different code path than REST API and triggers a full
 * Shopify storefront cache invalidation for each product.
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

const gql = async (query, variables = {}) => {
  const r = await fetch(`${BASE}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  await sleep(300);
  return r.json();
};

// Get all product GIDs
console.log('Fetching product IDs via GraphQL...');
let allProductIds = [];
let cursor = null;
let hasNext = true;
while (hasNext) {
  const res = await gql(`
    query GetProducts($cursor: String) {
      products(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges { node { id title } }
      }
    }
  `, { cursor });
  if (res.errors) { console.error('Fetch error:', res.errors); break; }
  const page = res.data.products;
  allProductIds.push(...page.edges.map(e => ({ id: e.node.id, title: e.node.title })));
  hasNext = page.pageInfo.hasNextPage;
  cursor = page.pageInfo.endCursor;
  if (hasNext) await sleep(300);
}
console.log(`Found ${allProductIds.length} products\n`);

// Force-touch each product via GraphQL productUpdate mutation
// Updating the SEO description or metafields would be too invasive.
// Instead, use productVariantsBulkUpdate to re-apply inventoryPolicy: CONTINUE on all variants.
const variantMutation = `
  mutation BulkUpdateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      userErrors { field message }
    }
  }
`;

let updated = 0, errors = 0;
for (let i = 0; i < allProductIds.length; i++) {
  const { id, title } = allProductIds[i];
  process.stdout.write(`  [${String(i + 1).padStart(3)}/${allProductIds.length}] ${title.slice(0, 55)}\r`);

  // Get all variants for this product
  const varRes = await gql(`
    query GetVariants($id: ID!) {
      product(id: $id) {
        variants(first: 100) {
          edges { node { id inventoryPolicy } }
        }
      }
    }
  `, { id });

  if (varRes.errors) {
    console.error(`\n  Error fetching variants for ${title.slice(0, 40)}:`, varRes.errors[0].message);
    errors++;
    continue;
  }

  const variants = varRes.data.product.variants.edges.map(e => ({
    id: e.node.id,
    inventoryPolicy: 'CONTINUE',
  }));

  const mutRes = await gql(variantMutation, { productId: id, variants });
  const errs = mutRes.data?.productVariantsBulkUpdate?.userErrors || [];
  if (mutRes.errors || errs.length > 0) {
    const msg = mutRes.errors?.[0]?.message || errs[0]?.message;
    console.error(`\n  Error updating ${title.slice(0, 40)}: ${msg}`);
    errors++;
  } else {
    updated++;
  }
}

console.log(`\n\n══ DONE ══════════════════════════════════════════════════════`);
console.log(`  Products force-published: ${updated}`);
console.log(`  Errors:                   ${errors}`);
console.log(`\n  Wait ~60 seconds then check: https://y2kase.com/collections/all`);
console.log(`  Expected: products show "Sale" badge instead of "Sold out"\n`);
