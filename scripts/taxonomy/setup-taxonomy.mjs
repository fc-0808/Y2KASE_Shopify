/**
 * Y2KASE Enterprise Taxonomy Setup
 *
 * Orchestrates all taxonomy operations in sequence:
 *  1. Classify all products
 *  2. Fix product types + tags (dry-run first, then apply)
 *  3. Create all smart collections
 *  4. Define metafields for structured filtering
 *
 * Usage:
 *   node scripts/taxonomy/setup-taxonomy.mjs --dry-run   (preview, no changes)
 *   node scripts/taxonomy/setup-taxonomy.mjs --apply     (make changes)
 *   node scripts/taxonomy/setup-taxonomy.mjs --collections-only  (collections only)
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { classifyProduct } from './classifier.mjs';
import { COLLECTIONS } from './collections-schema.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../../.env');

function loadEnv(filePath) {
  let text = readFileSync(filePath, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    process.env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
}

loadEnv(envPath);

const SHOP    = process.env.SHOPIFY_SHOP;
const TOKEN   = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const VERSION = process.env.SHOPIFY_API_VERSION || '2025-04';
const BASE    = `https://${SHOP}/admin/api/${VERSION}`;
const GQL_URL = `${BASE}/graphql.json`;

const ARGS     = process.argv.slice(2);
const DRY_RUN  = ARGS.includes('--dry-run') || !ARGS.includes('--apply');
const COL_ONLY = ARGS.includes('--collections-only');

if (DRY_RUN) {
  console.log('\n⚠️  DRY RUN MODE — no changes will be made. Pass --apply to execute.\n');
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function restGet(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'X-Shopify-Access-Token': TOKEN }
  });
  return res.json();
}

async function restPut(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function restPost(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function gql(query, variables = {}) {
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

// Rate limiter — stay under Shopify's 2 req/sec for REST
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function rateLimited(fn) {
  const result = await fn();
  await sleep(600);
  return result;
}

// ── Step 1: Classify all products ─────────────────────────────────────────────

console.log('\n══ STEP 1: CLASSIFYING PRODUCTS ════════════════════════════════');

const { products } = await restGet('/products.json?limit=250&fields=id,title,tags,product_type,variants');

const classifications = products.map(p => classifyProduct(p));

console.log(`\nClassified ${classifications.length} products:\n`);
console.log('Product'.padEnd(55) + ' Type'.padEnd(15) + ' Device'.padEnd(10) + ' Attach'.padEnd(12) + ' Characters');
console.log('─'.repeat(110));
for (const c of classifications) {
  const chars = c.characters.join(', ') || '(none)';
  console.log(
    c.title.slice(0, 52).padEnd(55) +
    c.shopifyProductType.padEnd(15) +
    c.deviceBrand.padEnd(10) +
    c.attachment.padEnd(12) +
    chars
  );
}

// ── Step 2: Update product types + tags ───────────────────────────────────────

if (!COL_ONLY) {
  console.log('\n══ STEP 2: UPDATING PRODUCT TYPES + TAGS ═══════════════════════');

  let updated = 0, skipped = 0, errors = 0;

  for (const c of classifications) {
    const newTags  = c.finalTags.join(', ');
    const needsTypeUpdate = products.find(p => p.id === c.id)?.product_type !== c.shopifyProductType;
    const currentTags = products.find(p => p.id === c.id)?.tags || '';
    const needsTagUpdate = currentTags !== newTags;

    if (!needsTypeUpdate && !needsTagUpdate) {
      skipped++;
      continue;
    }

    const shortTitle = c.title.slice(0, 50);

    if (DRY_RUN) {
      if (needsTypeUpdate) {
        console.log(`\n[DRY] ${shortTitle}`);
        console.log(`      type: "${products.find(p => p.id === c.id)?.product_type || '(empty)'}" → "${c.shopifyProductType}"`);
      }
      if (needsTagUpdate) {
        const oldTags = currentTags.split(',').map(t => t.trim()).sort();
        const newTagList = c.finalTags;
        const added   = newTagList.filter(t => !oldTags.includes(t));
        const removed = oldTags.filter(t => !newTagList.includes(t));
        if (!needsTypeUpdate) console.log(`\n[DRY] ${shortTitle}`);
        console.log(`      + added:   ${added.slice(0, 5).join(', ')}${added.length > 5 ? ` (+${added.length-5} more)` : ''}`);
        console.log(`      - removed: ${removed.slice(0, 5).join(', ')}${removed.length > 5 ? ` (+${removed.length-5} more)` : ''}`);
      }
      updated++;
      continue;
    }

    // Apply update
    const result = await rateLimited(() => restPut(`/products/${c.id}.json`, {
      product: {
        id: c.id,
        product_type: c.shopifyProductType,
        tags: newTags,
      }
    }));

    if (result.product) {
      console.log(`  ✅ Updated: ${shortTitle}`);
      updated++;
    } else {
      console.error(`  ❌ Error on ${shortTitle}:`, result.errors || result);
      errors++;
    }
  }

  console.log(`\nSummary: ${updated} updated, ${skipped} already correct, ${errors} errors`);
}

// ── Step 3: Create smart collections ─────────────────────────────────────────

console.log('\n══ STEP 3: CREATING SMART COLLECTIONS ══════════════════════════');

// Fetch existing collections to avoid duplicates
const { custom_collections, smart_collections } = await (async () => {
  const [cust, smart] = await Promise.all([
    restGet('/custom_collections.json?limit=250'),
    restGet('/smart_collections.json?limit=250'),
  ]);
  return { custom_collections: cust.custom_collections || [], smart_collections: smart.smart_collections || [] };
})();

const existingHandles = new Set([
  ...custom_collections.map(c => c.handle),
  ...smart_collections.map(c => c.handle),
]);

let colCreated = 0, colSkipped = 0, colErrors = 0;

for (const col of COLLECTIONS) {
  if (existingHandles.has(col.handle)) {
    console.log(`  ⏭  Skip (exists): ${col.title}`);
    colSkipped++;
    continue;
  }

  const payload = {
    smart_collection: {
      title: col.title,
      handle: col.handle,
      body_html: col.body_html,
      published: col.published ?? true,
      disjunctive: col.disjunctive ?? false,
      rules: col.rules,
      sort_order: col.sort_order || 'best-selling',
    }
  };

  if (DRY_RUN) {
    const ruleDesc = col.rules.map(r => `${r.column}=${r.condition}`).join(col.disjunctive ? ' OR ' : ' AND ');
    const vis = col.published ? 'public' : 'hidden';
    console.log(`  [DRY] Create: "${col.title}" (${vis}) — rules: ${ruleDesc}`);
    colCreated++;
    continue;
  }

  const result = await rateLimited(() => restPost('/smart_collections.json', payload));

  if (result.smart_collection) {
    console.log(`  ✅ Created: "${col.title}" (ID: ${result.smart_collection.id})`);
    colCreated++;
  } else {
    console.error(`  ❌ Error creating "${col.title}":`, JSON.stringify(result.errors || result));
    colErrors++;
  }
}

console.log(`\nCollections: ${colCreated} ${DRY_RUN ? 'would be created' : 'created'}, ${colSkipped} already existed, ${colErrors} errors`);

// ── Step 4: Define metafields ─────────────────────────────────────────────────

console.log('\n══ STEP 4: METAFIELD DEFINITIONS ════════════════════════════════');
console.log('  (Metafields power Shopify Search & Discovery app filters)');

const METAFIELD_DEFS = [
  {
    namespace: 'y2kase',
    key: 'character',
    name: 'Character',
    description: 'Primary character(s) featured on this product',
    type: 'list.single_line_text_field',
    ownerType: 'PRODUCT',
  },
  {
    namespace: 'y2kase',
    key: 'ip_brand',
    name: 'IP Brand',
    description: 'Intellectual property owner (Sanrio, Disney, Anime, Vocaloid)',
    type: 'list.single_line_text_field',
    ownerType: 'PRODUCT',
  },
  {
    namespace: 'y2kase',
    key: 'attachment_type',
    name: 'Attachment Type',
    description: 'How the product attaches (MagSafe, Adhesive, Standard)',
    type: 'single_line_text_field',
    ownerType: 'PRODUCT',
  },
  {
    namespace: 'y2kase',
    key: 'aesthetic',
    name: 'Aesthetic',
    description: 'Visual aesthetic (kawaii, coquette, y2k, jirai-kei)',
    type: 'list.single_line_text_field',
    ownerType: 'PRODUCT',
  },
  {
    namespace: 'y2kase',
    key: 'case_style',
    name: 'Case Style',
    description: 'Construction style (leather, glitter, wallet, holographic)',
    type: 'list.single_line_text_field',
    ownerType: 'PRODUCT',
  },
  {
    namespace: 'y2kase',
    key: 'compatible_models',
    name: 'Compatible Models',
    description: 'Device models this product is compatible with',
    type: 'list.single_line_text_field',
    ownerType: 'PRODUCT',
  },
];

for (const def of METAFIELD_DEFS) {
  if (DRY_RUN) {
    console.log(`  [DRY] Would create metafield: y2kase.${def.key} (${def.type})`);
    continue;
  }

  const result = await gql(`
    mutation metafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $definition) {
        createdDefinition { id name namespace key type { name } }
        userErrors { field message }
      }
    }
  `, {
    definition: {
      name: def.name,
      namespace: def.namespace,
      key: def.key,
      description: def.description,
      type: def.type,
      ownerType: def.ownerType,
    }
  });

  const errors = result.data?.metafieldDefinitionCreate?.userErrors;
  if (errors?.length) {
    const msg = errors[0].message;
    if (msg.includes('already exists') || msg.includes('taken')) {
      console.log(`  ⏭  Already exists: ${def.namespace}.${def.key}`);
    } else {
      console.error(`  ❌ Error creating metafield ${def.key}:`, msg);
    }
  } else {
    console.log(`  ✅ Created metafield: ${def.namespace}.${def.key}`);
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n══ COMPLETE ═════════════════════════════════════════════════════');
if (DRY_RUN) {
  console.log('\n  This was a DRY RUN. Run with --apply to execute all changes.\n');
} else {
  console.log('\n  All taxonomy operations complete.');
  console.log('  Next steps:');
  console.log('  1. Go to Shopify Admin → Content → Menus and link collections to navigation');
  console.log('  2. Add Shopify Search & Discovery app (free) to enable collection filter sidebar');
  console.log('  3. Set up collection page layout in theme editor');
  console.log('  4. When adding new products: tag with type:/device:/attach:/char:/ip: prefixes\n');
}
