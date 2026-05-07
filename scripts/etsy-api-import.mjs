/**
 * Y2KASE Etsy → Shopify Direct API Import Pipeline
 *
 * Ingests EtsyListingsDownload.csv and pushes products directly to the
 * Shopify Admin GraphQL API — no manual CSV upload required.
 *
 * Pipeline per product:
 *   Extract   → parse CSV record, normalise fields
 *   Transform → classify, rewrite title, build variants + metafields
 *   Load      → productSet → productCreateMedia → inventorySetOnHandQuantities
 *
 * Usage:
 *   node scripts/etsy-api-import.mjs --dry-run    Show API payloads for 1 product, no mutations
 *   node scripts/etsy-api-import.mjs --apply      Execute full import for all products
 *
 * npm shortcuts:
 *   npm run etsy:dry
 *   npm run etsy:apply
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath }    from 'node:url';
import { parseCsvFile }     from './lib/csv-parser.mjs';
import { buildShopifyPayload } from './lib/transform.mjs';
import { loadProduct }      from './lib/loader.mjs';
import { resolveLocationId } from './shopify-client.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');

const ARGS    = process.argv.slice(2);
const DRY_RUN = !ARGS.includes('--apply');

const CSV_PATH       = resolve(ROOT, 'EtsyListingsDownload.csv');
const LOCATION_NAME  = 'FLAT D 10/F BLOCK 6 LILY MANSION';

// ── Extraction helpers ────────────────────────────────────────────────────────

function splitAndTrim(val) {
  if (!val) return [];
  return val.split(',').map(v => v.trim()).filter(Boolean);
}

function extractImages(raw) {
  const images = [];
  for (let i = 1; i <= 10; i++) {
    const src = raw[`IMAGE${i}`]?.trim();
    if (src) images.push(src);
  }
  return images;
}

/**
 * Normalise a raw Etsy CSV record into a structured EtsyProduct object.
 * Pure extraction — no classification or title-rewriting at this stage.
 *
 * @param {Object} raw - one record from parseCsvFile()
 * @returns {EtsyProduct}
 */
function normalizeEtsyRecord(raw) {
  return {
    title:       (raw['TITLE']         ?? '').trim(),
    description: (raw['DESCRIPTION']   ?? '').trim(),
    price:       (raw['PRICE']         ?? '0').trim(),
    currency:    (raw['CURRENCY_CODE'] ?? 'HKD').trim(),
    quantity:    parseInt(raw['QUANTITY'] ?? '0', 10) || 0,
    tags:        splitAndTrim(raw['TAGS']),
    materials:   splitAndTrim(raw['MATERIALS']),
    images:      extractImages(raw),
    models:      splitAndTrim(raw['VARIATION 1 VALUES']),
    styles:      splitAndTrim(raw['VARIATION 2 VALUES']),
    etsySku:     (raw['SKU'] ?? '').trim(),
  };
}

// ── Dry-run payload display ───────────────────────────────────────────────────

/**
 * Print the three exact GraphQL mutation payloads that would be sent to the
 * Shopify API for one product. descriptionHtml is truncated for readability.
 *
 * @param {object} dryRunPayloads - from loadProduct() in dry-run mode
 * @param {string} locationId     - resolved GID shown for reference
 */
function printApiPayloads(dryRunPayloads, locationId) {
  const LINE = '─'.repeat(70);

  // ── Step 1: productSet ────────────────────────────────────────────────────
  console.log(`\n${LINE}`);
  console.log('  STEP 1 — productSet (creates product + all 72 variants)');
  console.log(LINE);

  // Clone and truncate descriptionHtml to avoid terminal flood
  const step1 = structuredClone(dryRunPayloads.step1_productSet);
  const fullHtml = step1.variables.input.descriptionHtml;
  step1.variables.input.descriptionHtml =
    `${fullHtml.slice(0, 120)}… [${fullHtml.length} chars total]`;

  // Show first 4 variants + "…N more" to prove the matrix is correct
  const allVariants = step1.variables.input.variants;
  step1.variables.input.variants = [
    ...allVariants.slice(0, 4),
    { _note: `… ${allVariants.length - 4} more variants (all rows generated identically)` },
  ];

  console.log(JSON.stringify(step1, null, 2));

  // ── Step 2: productCreateMedia ────────────────────────────────────────────
  console.log(`\n${LINE}`);
  console.log('  STEP 2 — productCreateMedia (attach images)');
  console.log(LINE);
  console.log(JSON.stringify(dryRunPayloads.step2_productCreateMedia, null, 2));

  // ── Step 3: inventorySetOnHandQuantities ──────────────────────────────────
  console.log(`\n${LINE}`);
  console.log('  STEP 3 — inventorySetOnHandQuantities (set stock per variant)');
  console.log(LINE);

  // Show first 4 + summary to avoid printing 72 placeholder GIDs
  const step3 = structuredClone(dryRunPayloads.step3_inventorySetOnHandQuantities);
  const allQty = step3.variables.input.setQuantities;
  step3.variables.input.setQuantities = [
    ...allQty.slice(0, 4),
    { _note: `… ${allQty.length - 4} more entries (one per variant, all at locationId above)` },
  ];

  console.log(JSON.stringify(step3, null, 2));
  console.log(`\n  Resolved locationId: ${locationId}`);
}

// ── --apply progress display ──────────────────────────────────────────────────

function printResult(result, index, total) {
  const prefix = `  [${String(index).padStart(3)}/${total}]`;
  switch (result.status) {
    case 'created':
      console.log(
        `${prefix} ✓  ${result.title.slice(0, 50).padEnd(52)}` +
        `  ${result.variantCount} variants · ${result.mediaCount} images · ${result.inventoryItemsSet} inventory`
      );
      break;
    case 'skipped':
      console.log(`${prefix} –  SKIP (already exists) ${result.title.slice(0, 50)}`);
      break;
    default:
      console.log(`${prefix} ?  ${result.status} ${result.title}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n══ Y2KASE Etsy → Shopify API Import ════════════════════════');
  console.log(`  Mode:     ${DRY_RUN ? 'DRY RUN (--dry-run)' : 'LIVE — mutations will fire'}`);
  console.log(`  CSV:      ${CSV_PATH}`);
  console.log(`  Location: ${LOCATION_NAME}`);
  console.log('');

  // ── Resolve fulfilment location (live API call even in dry-run) ────────────
  // This validates credentials and confirms the location name before any product
  // mutations fire. Fails loudly with the list of available locations if not found.
  process.stdout.write('  Resolving location ID…\r');
  const locationId = await resolveLocationId(LOCATION_NAME);
  console.log(`  Location resolved: ${locationId}`);
  console.log('');

  // ── Dry-run: process FIRST product only, output exact API payloads ─────────
  if (DRY_RUN) {
    console.log('  Building API payloads for first product…\n');

    for await (const raw of parseCsvFile(CSV_PATH)) {
      const etsyProduct    = normalizeEtsyRecord(raw);
      const shopifyPayload = buildShopifyPayload(etsyProduct);

      const result = await loadProduct(shopifyPayload, locationId, { dryRun: true });

      console.log(`${'═'.repeat(70)}`);
      console.log(`  PRODUCT: "${shopifyPayload.title}"`);
      console.log(`  Handle:  ${shopifyPayload.handle}`);
      console.log(`  Variants: ${shopifyPayload.variants.length}  ·  Images: ${shopifyPayload._images.length}  ·  Inventory qty: ${shopifyPayload._inventoryQty}`);
      console.log(`${'═'.repeat(70)}`);

      printApiPayloads(result.dryRunPayloads, locationId);

      console.log(`\n${'═'.repeat(70)}`);
      console.log('  DRY RUN COMPLETE — no mutations were executed.');
      console.log('  Verify the payloads above, then run:');
      console.log('    npm run etsy:apply');
      console.log(`${'═'.repeat(70)}\n`);

      break; // first product only
    }

    return;
  }

  // ── Live --apply: process all products ────────────────────────────────────
  console.log('  Starting live import…\n');

  const summary = { created: 0, skipped: 0, errors: 0 };
  const errors  = [];
  let   total   = 0;

  // First pass: count total for progress display
  for await (const _ of parseCsvFile(CSV_PATH)) total++;

  let index = 0;
  for await (const raw of parseCsvFile(CSV_PATH)) {
    index++;
    const etsyProduct    = normalizeEtsyRecord(raw);
    const shopifyPayload = buildShopifyPayload(etsyProduct);

    try {
      const result = await loadProduct(shopifyPayload, locationId, {
        dryRun:       false,
        skipExisting: true,
      });

      printResult(result, index, total);
      summary[result.status === 'created' ? 'created' : 'skipped']++;

    } catch (err) {
      console.error(`\n  [${index}/${total}] ✗  ERROR on "${etsyProduct.title.slice(0, 50)}"`);
      console.error(`         ${err.message}\n`);
      errors.push({ index, title: etsyProduct.title, error: err.message });
      summary.errors++;
    }
  }

  // ── Final summary ─────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(70)}`);
  console.log('  IMPORT COMPLETE');
  console.log(`${'═'.repeat(70)}`);
  console.log(`  Products created:  ${summary.created}`);
  console.log(`  Products skipped:  ${summary.skipped}  (already existed)`);
  console.log(`  Errors:            ${summary.errors}`);

  if (errors.length > 0) {
    console.log('\n  Failed products:');
    for (const e of errors) {
      console.log(`    [${e.index}] ${e.title.slice(0, 60)}`);
      console.log(`         ${e.error}`);
    }
    console.log('\n  Re-run with --apply to retry only the failed products (skips successful ones).');
  }

  console.log('');
}

main().catch(err => {
  console.error('\n  FATAL:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
