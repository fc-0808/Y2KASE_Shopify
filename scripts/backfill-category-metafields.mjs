#!/usr/bin/env node
/**
 * Y2KASE — Category Metafields Backfiller
 *
 * Sets the 4 auto-settable taxonomy attributes (material, theme,
 * attachment-options, connectivity-technology) for ALL previously imported
 * products, using the Metaobject GID cache built by discover-metaobj-gids.mjs.
 *
 * PREREQUISITES
 * ─────────────
 * 1. Run the one-time bootstrap:
 *      a. Open any imported product in Shopify Admin
 *      b. In "Category metafields", fill in Material, Theme, Attachment options
 *      c. Save the product
 *      d. node scripts/lib/discover-metaobj-gids.mjs <product-handle>
 *
 * USAGE
 * ─────
 *   node scripts/backfill-category-metafields.mjs [--dry-run] [--tag y2kase-import]
 *
 *   --dry-run     Print what would be set without calling the API
 *   --tag TAG     Filter by product tag (default: y2kase-import)
 *   --limit N     Process at most N products (default: all)
 */

import { existsSync, readFileSync } from 'fs';
import { resolve, dirname }         from 'path';
import { fileURLToPath }            from 'url';
import { shopifyGql }               from './shopify-client.mjs';
import { buildCategoryMetafields }  from './lib/category-metafields.mjs';
import { buildStandardAttrMetafields, METAFIELDS_SET_MUTATION }
                                    from './lib/loader.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const METAOBJ_CACHE = resolve(__dirname, '../.cache/taxonomy-metaobj-gid-cache.json');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const TAG     = (() => { const i = args.indexOf('--tag');   return i >= 0 ? args[i+1] : 'y2kase-import'; })();
const LIMIT   = (() => { const i = args.indexOf('--limit'); return i >= 0 ? parseInt(args[i+1], 10) : Infinity; })();

// ── Guard: cache must exist ───────────────────────────────────────────────────
if (!existsSync(METAOBJ_CACHE)) {
  console.error('✗ Metaobject GID cache not found:', METAOBJ_CACHE);
  console.error('');
  console.error('  ACTION REQUIRED — one-time bootstrap:');
  console.error('  1. Open any imported product in Shopify Admin');
  console.error('  2. Under "Category metafields", fill in:');
  console.error('       • Material    → e.g. "Thermoplastic polyurethane (TPU)"');
  console.error('       • Theme       → e.g. "Cartoons"');
  console.error('       • Attachment options → e.g. "Magnet"');
  console.error('  3. Save the product');
  console.error('  4. Run: node scripts/lib/discover-metaobj-gids.mjs <handle>');
  console.error('  5. Re-run this script');
  process.exit(1);
}

const cache = JSON.parse(readFileSync(METAOBJ_CACHE, 'utf-8'));
const availableAttrs = Object.keys(cache.attributes ?? {});
if (availableAttrs.length === 0) {
  console.error('✗ Cache exists but has no attributes. Re-run discover-metaobj-gids.mjs.');
  process.exit(1);
}

console.log(`Metaobject GID cache: ${availableAttrs.join(', ')} (${cache.discoveredAt})`);
console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}   Tag filter: ${TAG}   Limit: ${LIMIT === Infinity ? 'all' : LIMIT}`);
console.log('');

// ── Query all imported products with the tag ──────────────────────────────────
const PRODUCTS_Q = /* GraphQL */ `
  query GetImportedProducts($query: String!, $cursor: String) {
    products(first: 50, query: $query, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        id handle title
        metafields(first: 30) {
          edges { node { namespace key value } }
        }
      } }
    }
  }
`;

let products = [];
let cursor = null;
process.stdout.write('Fetching products…');
do {
  const r = await shopifyGql(PRODUCTS_Q, { query: `tag:${TAG}`, cursor });
  const conn = r.data?.products;
  const edges = conn?.edges ?? [];
  for (const { node: p } of edges) {
    const mfs = p.metafields.edges.map(e => e.node);
    products.push({ id: p.id, handle: p.handle, title: p.title, mfs });
  }
  process.stdout.write(` ${products.length}`);
  if (conn?.pageInfo?.hasNextPage) cursor = conn.pageInfo.endCursor;
  else break;
} while (products.length < LIMIT);

if (LIMIT < Infinity) products = products.slice(0, LIMIT);
console.log(`\nFound ${products.length} product(s) to process.\n`);

// ── Process each product ──────────────────────────────────────────────────────
const DELAY_MS = 600;  // ~1.7 req/s — safely under rate limits for just metafieldsSet

let processed = 0, skipped = 0, errors = 0;

for (const p of products) {
  process.stdout.write(`  [${processed + skipped + errors + 1}/${products.length}] ${p.handle} … `);

  // Reconstruct classification from stored y2kase.* metafields
  const get = (key) => {
    const mf = p.mfs.find(m => m.namespace === 'y2kase' && m.key === key);
    if (!mf) return null;
    try { const parsed = JSON.parse(mf.value); return Array.isArray(parsed) ? parsed : [parsed]; }
    catch { return mf.value ? [mf.value] : null; }
  };

  const classification = {
    ipBrands:   get('ip_brand')       ?? [],
    aesthetics: get('aesthetic')      ?? [],
    characters: get('character')      ?? [],
    styles:     get('case_style')     ?? [],
    features:   [],                          // not stored as metafield; OK default
    attachment: (get('attachment_type') ?? []).includes('magsafe') ? 'magsafe' : 'none',
  };

  // Build taxonomy metafields (TaxonomyValue GIDs format)
  const shopifyMfs = buildCategoryMetafields(classification);

  // Convert to Metaobject GIDs for the 4 standard-definition attributes
  const stdMfs = buildStandardAttrMetafields(shopifyMfs);

  if (stdMfs.length === 0) {
    console.log('skip (no standard attrs to set for this classification)');
    skipped++;
    continue;
  }

  if (DRY_RUN) {
    console.log(`would set ${stdMfs.length} attr(s): ${stdMfs.map(m => `${m.key}=${JSON.parse(m.value).join(',')}`).join('  ')}`);
    processed++;
    continue;
  }

  // Call metafieldsSet
  try {
    const result = await shopifyGql(METAFIELDS_SET_MUTATION, {
      metafields: stdMfs.map(mf => ({
        ownerId:   p.id,
        namespace: mf.namespace,
        key:       mf.key,
        type:      mf.type,
        value:     mf.value,
      })),
    });

    const ue  = result.data?.metafieldsSet?.userErrors ?? [];
    const set = result.data?.metafieldsSet?.metafields ?? [];

    if (ue.length > 0) {
      const msgs = ue.map(e => `[${e.code}] ${e.message}`).join('; ');
      console.log(`WARN: ${set.length}/${stdMfs.length} set — ${msgs}`);
      if (set.length === 0) errors++; else processed++;
    } else {
      console.log(`✓ set ${set.length} attr(s): ${set.map(m => m.key).join(', ')}`);
      processed++;
    }
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
    errors++;
  }

  await new Promise(r => setTimeout(r, DELAY_MS));
}

console.log(`\nDone — ${processed} updated, ${skipped} skipped, ${errors} errors.`);
if (DRY_RUN) console.log('\n(Dry run — no API calls made. Remove --dry-run to apply.)');
