/**
 * Y2KASE — Force inventory-level refresh via inventorySetOnHandQuantities (GraphQL)
 *
 * Sets every inventory item to a fixed positive quantity (3) at the store's
 * fulfillment location. Updated to use the GraphQL Admin API (2026-04 compatible)
 * instead of the deprecated REST POST /inventory_levels/set.json endpoint.
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
const GQL_URL = `https://${SHOP}/admin/api/${VER}/graphql.json`;
const sleep   = ms => new Promise(r => setTimeout(r, ms));

const gql = async (query, variables = {}) => {
  const r = await fetch(GQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  await sleep(250);
  return r.json();
};

// ── Step 1: Resolve fulfillment location GID ──────────────────────────────────

console.log('Finding fulfillment location...');
const locsRes  = await gql(`{ locations(first: 50, includeInactive: false) { edges { node { id name } } } }`);
const locations = locsRes.data?.locations?.edges?.map(e => e.node) ?? [];
if (!locations.length) { console.error('No locations found. Aborting.'); process.exit(1); }
// Use first active location (same heuristic as the old REST version)
const locationGid = locations[0].id;
console.log(`Using location: ${locations[0].name} (${locationGid})\n`);

// ── Step 2: Fetch all products + their inventory items via GraphQL ─────────────

console.log('Fetching all products...');
const allInventoryItems = [];
let cursor = null, hasNext = true;

while (hasNext) {
  const res = await gql(`
    query($cursor: String) {
      products(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            title
            variants(first: 250) {
              edges {
                node {
                  inventoryItem {
                    id
                    tracked
                    inventoryLevel(locationId: "${locationGid ? locationGid : ''}") {
                      quantities(names: ["on_hand"]) { name quantity }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `, { cursor });

  const page = res.data?.products;
  for (const { node: p } of (page?.edges ?? [])) {
    for (const { node: v } of (p.variants?.edges ?? [])) {
      const item     = v.inventoryItem;
      const onHand   = item?.inventoryLevel?.quantities?.find(q => q.name === 'on_hand')?.quantity ?? 0;
      if (item?.tracked && onHand <= 0) {
        allInventoryItems.push({ inventoryItemId: item.id, productTitle: p.title.slice(0, 40) });
      }
    }
  }

  hasNext = page?.pageInfo?.hasNextPage ?? false;
  cursor  = page?.pageInfo?.endCursor ?? null;
}

console.log(`Found ${allInventoryItems.length} tracked zero-stock variants to refill to qty=3\n`);

// ── Step 3: Set inventory via inventorySetOnHandQuantities (GraphQL) ──────────

const INVENTORY_SET_MUTATION = `
  mutation inventorySetOnHandQuantities($input: InventorySetOnHandQuantitiesInput!) {
    inventorySetOnHandQuantities(input: $input) {
      userErrors { field message }
      inventoryAdjustmentGroup {
        createdAt
        changes { name delta quantityAfterChange }
      }
    }
  }
`;

const BATCH_SIZE = 100;
let success = 0, errors = 0;

for (let i = 0; i < allInventoryItems.length; i += BATCH_SIZE) {
  const batch = allInventoryItems.slice(i, i + BATCH_SIZE);
  process.stdout.write(`  Setting qty=3 for ${i + 1}–${Math.min(i + BATCH_SIZE, allInventoryItems.length)} of ${allInventoryItems.length}\r`);

  const res = await gql(INVENTORY_SET_MUTATION, {
    input: {
      reason: 'correction',
      setQuantities: batch.map(item => ({
        inventoryItemId:  item.inventoryItemId,
        locationId:       locationGid,
        quantity:         3,
        changeFromQuantity: null,
      })),
    },
  });

  const errs = res.data?.inventorySetOnHandQuantities?.userErrors ?? [];
  if (res.errors || errs.length > 0) {
    const msg = res.errors?.[0]?.message || errs[0]?.message;
    console.error(`\n  ❌ Batch ${Math.floor(i / BATCH_SIZE) + 1} error: ${msg}`);
    errors += batch.length;
  } else {
    success += batch.length;
  }
}

if (allInventoryItems.length === 0) {
  console.log('No zero-stock tracked variants found — inventory is already at positive levels.');
  console.log('The "Sold out" badges may be a CDN cache issue. Please wait a few minutes and refresh.');
} else {
  console.log(`\n\n══ DONE ══════════════════════════════════════════════════════`);
  console.log(`  Inventory levels set to 3:  ${success} variants`);
  console.log(`  Errors:                     ${errors}`);
  console.log(`\n  Verify at: https://y2kase.com/collections/all\n`);
}
