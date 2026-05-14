/**
 * Y2KASE — Metaobject GID Discovery Tool
 *
 * HOW IT WORKS
 * ════════════
 * Shopify's "Category metafields" for the Mobile Phone Cases category are stored
 * as metafields in the `shopify` namespace with type `list.metaobject_reference`.
 * The VALUES must be Metaobject GIDs (gid://shopify/Metaobject/…), NOT the
 * TaxonomyValue GIDs that fetch-taxonomy-attrs.mjs collects.
 *
 * Shopify does not expose these Metaobject GIDs via any taxonomy query.  The only
 * way to discover them is to:
 *   1. Manually set a Category metafield value in Shopify Admin for any product.
 *   2. Run this script — it reads the stored Metaobject GIDs from that product,
 *      resolves each Metaobject's type, enumerates ALL instances of that type, and
 *      builds a display-name → GID mapping for every discovered attribute.
 *   3. The mapping is saved to .cache/taxonomy-metaobj-gid-cache.json and used
 *      automatically by loader.mjs in Step 4 (setStandardCategoryMetafields).
 *
 * ONE-TIME BOOTSTRAP — after running this once the cache is permanent until
 * Shopify changes their platform metaobject IDs (very rare).
 *
 * USAGE
 * ─────
 *   # Default: inspects the most recently imported product
 *   node scripts/lib/discover-metaobj-gids.mjs
 *
 *   # Or specify any product handle that has been manually edited in Admin
 *   node scripts/lib/discover-metaobj-gids.mjs <product-handle>
 *
 * WHAT TO DO FIRST
 * ────────────────
 *   1. Open any imported product in Shopify Admin
 *   2. Scroll to "Category metafields" → set at least one value per attribute
 *      you want auto-populated (e.g. Theme → "Cartoons", Material → "Plastic")
 *   3. Save the product
 *   4. Run this script
 *
 * WHICH ATTRIBUTES CAN BE AUTO-SET
 * ─────────────────────────────────
 * Only attributes that have an enabled "standard metafield definition" can be
 * set by a private app.  The four definitions we enabled are:
 *   • shopify.material
 *   • shopify.theme
 *   • shopify.attachment-options
 *   • shopify.connectivity-technology
 *
 * The following remain manual-only (Shopify APP_NOT_AUTHORIZED restriction):
 *   case-type, case-transparency-level, bag-case-material, finish,
 *   magsafe-compatibility, mobile-phone-case-features, screen-protection-features,
 *   integrated-stand-type, wallet-features
 */

import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { shopifyGql } from '../shopify-client.mjs';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = resolve(__dirname, '../../.cache/taxonomy-metaobj-gid-cache.json');

// The 4 attributes with enabled standard metafield definitions
const STANDARD_ATTRS = ['material', 'theme', 'attachment-options', 'connectivity-technology'];

const handle = process.argv[2] ?? 'tamagotchi-y2k-magsafe-iphone-case-with-grip-charm';

// ── Step 1: Find the product ──────────────────────────────────────────────────
const FIND = /* GraphQL */ `
  query FindProduct($handle: String!) {
    productByIdentifier(identifier: { handle: $handle }) {
      id title
    }
  }
`;
const foundR = await shopifyGql(FIND, { handle });
const product = foundR.data?.productByIdentifier;
if (!product) {
  console.error(`✗ Product not found: "${handle}"`);
  console.error('  Run: node scripts/lib/discover-metaobj-gids.mjs <product-handle>');
  process.exit(1);
}
console.log(`Product: ${product.title}\n`);

// ── Step 2: Read shopify.* metafields on this product ─────────────────────────
const MF_Q = /* GraphQL */ `
  query GetMeta($id: ID!) {
    product(id: $id) {
      metafields(first: 50) {
        edges { node { namespace key type value } }
      }
    }
  }
`;
const mfR = await shopifyGql(MF_Q, { id: product.id });
const allMfs = mfR.data?.product?.metafields?.edges ?? [];
const shopifyMfs = allMfs
  .map(e => e.node)
  .filter(mf => mf.namespace === 'shopify' && STANDARD_ATTRS.includes(mf.key));

if (shopifyMfs.length === 0) {
  console.error('✗ No shopify.* Category metafields found on this product.');
  console.error('');
  console.error('  ACTION REQUIRED:');
  console.error('  1. Open this product in Shopify Admin:');
  console.error(`     https://admin.shopify.com/products (search for "${handle}")`);
  console.error('  2. Scroll to "Category metafields"');
  console.error('  3. Set values for: Theme, Material, Attachment options, Connectivity technology');
  console.error('  4. Save the product');
  console.error('  5. Re-run this script');
  process.exit(1);
}

console.log(`Found ${shopifyMfs.length} shopify.* metafield(s) to process:`);
shopifyMfs.forEach(mf => console.log(`  shopify.${mf.key} [${mf.type}] = ${mf.value.slice(0, 80)}`));
console.log('');

// ── Step 3: For each metafield, resolve Metaobject instances ──────────────────
const gidCache = {};   // { attrKey: { "Display Name": "gid://shopify/Metaobject/XXX" } }
const typeMap   = {};  // { attrKey: metaobjectType }

for (const mf of shopifyMfs) {
  let mobjGids;
  try { mobjGids = JSON.parse(mf.value); } catch { continue; }
  if (!Array.isArray(mobjGids) || mobjGids.length === 0) continue;

  // Resolve the first GID to find the metaobject type
  const firstGid = mobjGids[0];
  const NODE_Q = /* GraphQL */ `
    query ResolveNode($id: ID!) {
      node(id: $id) {
        id __typename
        ... on Metaobject {
          type handle
          fields { key value }
        }
      }
    }
  `;
  const nodeR = await shopifyGql(NODE_Q, { id: firstGid });
  const mobjNode = nodeR.data?.node;

  if (!mobjNode || mobjNode.__typename !== 'Metaobject') {
    console.warn(`  ⚠ ${firstGid} did not resolve to a Metaobject (got ${mobjNode?.__typename ?? 'null'})`);
    continue;
  }

  const mobjType = mobjNode.type;
  typeMap[mf.key] = mobjType;
  console.log(`  shopify.${mf.key} → metaobject type: ${mobjType}`);

  // Enumerate ALL instances of this type to build the complete name→GID mapping
  const LIST_Q = /* GraphQL */ `
    query ListMobjs($type: String!, $cursor: String) {
      metaobjects(type: $type, first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges { node {
          id handle type
          fields { key value }
        } }
      }
    }
  `;

  const nameToGid = {};
  let cursor = null;
  let page = 0;
  let totalFetched = 0;

  do {
    const listR = await shopifyGql(LIST_Q, { type: mobjType, cursor });
    const conn   = listR.data?.metaobjects;
    const edges  = conn?.edges ?? [];
    totalFetched += edges.length;
    page++;

    for (const { node: m } of edges) {
      // Try common field keys for the display name
      const nameField = m.fields?.find(f =>
        ['name', 'label', 'title', 'display_name'].includes(f.key)
      );
      const displayName = nameField?.value ?? m.handle;
      if (displayName) nameToGid[displayName] = m.id;
    }

    if (conn?.pageInfo?.hasNextPage) {
      cursor = conn.pageInfo.endCursor;
    } else {
      break;
    }
  } while (page < 20);

  console.log(`    → ${totalFetched} instances enumerated, ${Object.keys(nameToGid).length} named`);
  gidCache[mf.key] = nameToGid;
}

// ── Step 4: Save cache ────────────────────────────────────────────────────────
const output = {
  discoveredAt:    new Date().toISOString(),
  discoveredFrom:  handle,
  typeMap,
  attributes: gidCache,
};

writeFileSync(CACHE_PATH, JSON.stringify(output, null, 2), 'utf-8');
console.log(`\n✓ Saved Metaobject GID cache → ${CACHE_PATH}`);
console.log(`\nAttributes ready for auto-import (${Object.keys(gidCache).length}):`);
for (const [key, vals] of Object.entries(gidCache)) {
  console.log(`  shopify.${key}: ${Object.keys(vals).length} values`);
  Object.entries(vals).slice(0, 5).forEach(([name, gid]) => {
    console.log(`    "${name}" → ${gid}`);
  });
  if (Object.keys(vals).length > 5) console.log(`    … and ${Object.keys(vals).length - 5} more`);
}

console.log('\nNext step: Run an import. loader.mjs will auto-set these attributes via metafieldsSet.');
