/**
 * Y2KASE Post-Import Pipeline
 *
 * Run this after every Shuttle import from Etsy.
 * Handles 1–1000+ products automatically.
 *
 * What it does:
 *  1. Fetches all products (paginated — handles 1000+)
 *  2. Identifies newly imported / unclassified products
 *  3. Classifies them (type, device, attachment, characters, etc.)
 *  4. Rewrites Etsy-style titles to SEO-optimised Google titles
 *  5. Applies full taxonomy tag set
 *  6. Sets product_type field
 *  7. Creates any new smart collections for new characters detected
 *  8. Reports a summary
 *
 * Usage:
 *   node scripts/post-import-pipeline.mjs --dry-run     (preview)
 *   node scripts/post-import-pipeline.mjs --apply       (execute)
 *   node scripts/post-import-pipeline.mjs --apply --new-only  (only untagged products)
 *
 * Rate limiting: respects Shopify Basic plan (2 req/sec)
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { classifyProduct } from './taxonomy/classifier.mjs';
import { generateTitle, needsTitleRewrite } from './taxonomy/title-generator.mjs';
import { COLLECTIONS } from './taxonomy/collections-schema.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv(f) {
  let t = readFileSync(f, 'utf8');
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  for (const line of t.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq === -1) continue;
    process.env[s.slice(0, eq).trim()] = s.slice(eq + 1).trim();
  }
}

loadEnv(resolve(__dirname, '../.env'));

const SHOP    = process.env.SHOPIFY_SHOP;
const TOKEN   = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const VERSION = process.env.SHOPIFY_API_VERSION || '2025-04';
const BASE    = `https://${SHOP}/admin/api/${VERSION}`;
const GQL     = `${BASE}/graphql.json`;

const ARGS     = process.argv.slice(2);
const DRY      = !ARGS.includes('--apply');
const NEW_ONLY = ARGS.includes('--new-only');

// Rate limiting — Basic plan: 2 req/sec, leave headroom
const DELAY_MS = 600;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

if (DRY) console.log('\n⚠️  DRY RUN — pass --apply to execute\n');
if (NEW_ONLY) console.log('📌  --new-only: skipping products that already have taxonomy tags\n');

// ── API helpers ───────────────────────────────────────────────────────────────

async function restGet(path) {
  const r = await fetch(`${BASE}${path}`, { headers: { 'X-Shopify-Access-Token': TOKEN } });
  const linkHeader = r.headers.get('link') || '';
  const data = await r.json();
  // Extract next page URL from Link header
  const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return { data, nextUrl: nextMatch ? nextMatch[1] : null };
}

async function restPut(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await sleep(DELAY_MS);
  return r.json();
}

async function restPost(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await sleep(DELAY_MS);
  return r.json();
}

async function gqlQuery(query, variables = {}) {
  const r = await fetch(GQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  await sleep(DELAY_MS);
  return r.json();
}

// ── Step 1: Fetch ALL products (paginated) ────────────────────────────────────

console.log('══ STEP 1: FETCHING ALL PRODUCTS ════════════════════════════');

const allProducts = [];
let url = `${BASE}/products.json?limit=250&fields=id,title,tags,product_type,variants,status`;
let page = 1;

while (url) {
  process.stdout.write(`  Fetching page ${page} (${allProducts.length} so far)...\r`);
  const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': TOKEN } });
  const linkHeader = r.headers.get('link') || '';
  const { products } = await r.json();
  allProducts.push(...(products || []));
  const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  url = nextMatch ? nextMatch[1] : null;
  page++;
  if (url) await sleep(DELAY_MS);
}

console.log(`\n  Total products fetched: ${allProducts.length}`);

// ── Step 2: Filter and classify ───────────────────────────────────────────────

console.log('\n══ STEP 2: CLASSIFYING PRODUCTS ══════════════════════════════');

const toProcess = NEW_ONLY
  ? allProducts.filter(p => {
      const tags = (p.tags || '').split(',').map(t => t.trim());
      return !tags.some(t => t.startsWith('type:') || t.startsWith('char:'));
    })
  : allProducts;

console.log(`  Products to process: ${toProcess.length}${NEW_ONLY ? ' (new/untagged only)' : ' (all)'}`);

const classifications = toProcess.map(p => ({
  product: p,
  ...classifyProduct(p),
  needsNewTitle: needsTitleRewrite(p.title),
  generatedTitle: null,
}));

// Generate titles for those that need it
for (const c of classifications) {
  if (c.needsNewTitle) {
    c.generatedTitle = generateTitle(c);
  }
}

// Count what needs updating
const needsUpdate     = classifications.filter(c => c.needsNewTitle || !c.product.product_type || true);
const needsTitle      = classifications.filter(c => c.needsNewTitle);
const newCharacters   = new Set(classifications.flatMap(c => c.characters));

console.log(`\n  Products needing title rewrite: ${needsTitle.length}`);
console.log(`  Characters detected across all products: ${[...newCharacters].join(', ')}`);

// ── Step 3: Apply updates ─────────────────────────────────────────────────────

console.log('\n══ STEP 3: UPDATING PRODUCTS ════════════════════════════════');

let updated = 0, skipped = 0, errors = 0;
const startTime = Date.now();

for (let i = 0; i < classifications.length; i++) {
  const c = classifications[i];
  const p = c.product;

  const newTitle = c.needsNewTitle ? c.generatedTitle : p.title;
  const newTags  = c.finalTags.join(', ');
  const newType  = c.shopifyProductType;

  const titleChanged = newTitle !== p.title;
  const tagsChanged  = newTags !== (p.tags || '');
  const typeChanged  = newType !== (p.product_type || '');

  // Skip if nothing actually changed
  const currentTags = (p.tags || '').split(',').map(t=>t.trim()).sort().join(', ');
  const sortedNewTags = c.finalTags.slice().sort().join(', ');
  if (!titleChanged && currentTags === sortedNewTags && !typeChanged) {
    skipped++;
    continue;
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const rate    = updated > 0 ? (updated / elapsed).toFixed(1) : '?';
  const eta     = updated > 0 ? Math.round((classifications.length - i) / (updated / elapsed)) : '?';
  process.stdout.write(`  [${i+1}/${classifications.length}] ${rate}/s · ETA ${eta}s · ${p.title.slice(0,40)}\r`);

  if (DRY) {
    if (titleChanged) console.log(`\n  [DRY] [${newTitle?.length}c] ${newTitle}`);
    updated++;
    continue;
  }

  const result = await restPut(`/products/${p.id}.json`, {
    product: {
      id: p.id,
      title: newTitle,
      tags: newTags,
      product_type: newType,
    }
  });

  if (result.product) {
    updated++;
  } else {
    console.error(`\n  ❌ Error on "${p.title.slice(0,40)}":`, result.errors || 'unknown');
    errors++;
  }
}

console.log(`\n\n  Updated: ${updated} · Skipped (no change): ${skipped} · Errors: ${errors}`);

// ── Step 4: Create missing collections for new characters ─────────────────────

console.log('\n══ STEP 4: CREATING MISSING COLLECTIONS ═════════════════════');

// Fetch existing collection handles
const [smartRes, customRes] = await Promise.all([
  fetch(`${BASE}/smart_collections.json?limit=250&fields=handle`, { headers: { 'X-Shopify-Access-Token': TOKEN } }).then(r=>r.json()),
  fetch(`${BASE}/custom_collections.json?limit=250&fields=handle`, { headers: { 'X-Shopify-Access-Token': TOKEN } }).then(r=>r.json()),
]);
const existingHandles = new Set([
  ...(smartRes.smart_collections||[]).map(c=>c.handle),
  ...(customRes.custom_collections||[]).map(c=>c.handle),
]);

// Build collections needed for new characters
const newColsNeeded = [];
for (const charId of newCharacters) {
  const handle = charId; // e.g. "sailor-moon"
  if (!existingHandles.has(handle)) {
    // Find character display name
    const displayName = charId.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
    newColsNeeded.push({
      handle,
      title: displayName,
      body_html: `<p>${displayName} iPhone cases and accessories.</p>`,
      published: true,
      disjunctive: false,
      rules: [{ column: 'tag', relation: 'equals', condition: `char:${charId}` }],
      sort_order: 'best-selling',
    });
  }
}

// Also check product-type collections (samsung, airpod, etc.)
const typeCollections = [
  { handle: 'samsung-cases', title: 'Samsung Cases', rule: { column: 'type', relation: 'equals', condition: 'Samsung Case' } },
  { handle: 'airpod-cases',  title: 'AirPod Cases',  rule: { column: 'type', relation: 'equals', condition: 'AirPod Case' } },
  { handle: 'watch-straps',  title: 'Apple Watch Straps', rule: { column: 'type', relation: 'equals', condition: 'Watch Strap' } },
  { handle: 'popsockets',    title: 'PopSockets & Grips', rule: { column: 'type', relation: 'equals', condition: 'PopSocket' } },
  { handle: 'charms',        title: 'Charms',         rule: { column: 'type', relation: 'equals', condition: 'Charm' } },
];

for (const col of typeCollections) {
  // Check if this type actually has products
  const hasProducts = classifications.some(c => c.shopifyProductType === col.rule.condition);
  if (hasProducts && !existingHandles.has(col.handle)) {
    newColsNeeded.push({
      handle: col.handle,
      title: col.title,
      body_html: `<p>${col.title} from Y2KASE.</p>`,
      published: true,
      disjunctive: false,
      rules: [col.rule],
      sort_order: 'best-selling',
    });
  }
}

if (newColsNeeded.length === 0) {
  console.log('  No new collections needed.');
} else {
  console.log(`  Creating ${newColsNeeded.length} new collections:`);
  for (const col of newColsNeeded) {
    if (DRY) {
      console.log(`  [DRY] Would create: "${col.title}" (${col.handle})`);
      continue;
    }
    const result = await restPost('/smart_collections.json', { smart_collection: col });
    if (result.smart_collection) {
      console.log(`  ✅ Created: "${col.title}"`);
    } else {
      console.error(`  ❌ Error creating "${col.title}":`, JSON.stringify(result.errors));
    }
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

const totalTime = Math.round((Date.now() - startTime) / 1000);
console.log(`
══ PIPELINE COMPLETE ════════════════════════════════════════
  Products processed:    ${toProcess.length}
  Products updated:      ${updated}
  Products skipped:      ${skipped}
  New collections:       ${newColsNeeded.length}
  Errors:                ${errors}
  Time:                  ${totalTime}s
${DRY ? '\n  DRY RUN — run with --apply to execute' : '\n  All done. Collections auto-populated via smart rules.'}
`);
