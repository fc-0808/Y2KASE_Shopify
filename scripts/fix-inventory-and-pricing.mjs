/**
 * Y2KASE — Fix Inventory + Apply 50% Sale Pricing
 *
 * INVENTORY FIX:
 *   Sets inventory_policy = 'continue' on all variants so products
 *   never show as "Sold Out" regardless of tracked quantity.
 *   (Correct for Etsy-sourced / dropship business model)
 *
 * PRICING FIX:
 *   Sets compare_at_price = original price (shows as crossed-out "was" price)
 *   Sets price = original × 0.5 (50% sale price)
 *   Multi-currency safe — Shopify converts both prices per market.
 *
 * Usage:
 *   node scripts/fix-inventory-and-pricing.mjs --dry-run
 *   node scripts/fix-inventory-and-pricing.mjs --apply
 *   node scripts/fix-inventory-and-pricing.mjs --apply --inventory-only
 *   node scripts/fix-inventory-and-pricing.mjs --apply --pricing-only
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
const VERSION = process.env.SHOPIFY_API_VERSION || '2025-04';
const BASE    = `https://${SHOP}/admin/api/${VERSION}`;

const ARGS         = process.argv.slice(2);
const DRY          = !ARGS.includes('--apply');
const INV_ONLY     = ARGS.includes('--inventory-only');
const PRICING_ONLY = ARGS.includes('--pricing-only');
const DO_INV       = !PRICING_ONLY;
const DO_PRICING   = !INV_ONLY;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const get  = async (p) => { const r = await fetch(`${BASE}${p}`, {headers:{'X-Shopify-Access-Token':TOKEN}}); return r.json(); };
const put  = async (p, b) => { const r = await fetch(`${BASE}${p}`, {method:'PUT',headers:{'X-Shopify-Access-Token':TOKEN,'Content-Type':'application/json'},body:JSON.stringify(b)}); await sleep(550); return r.json(); };

if (DRY) console.log('\n⚠️  DRY RUN — pass --apply to execute\n');

// ── Fetch all products (paginated) ────────────────────────────────────────────

console.log('Fetching all products...');
const allProducts = [];
let url = `${BASE}/products.json?limit=250&fields=id,title,variants,status`;
while (url) {
  const r   = await fetch(url, { headers: { 'X-Shopify-Access-Token': TOKEN } });
  const link = r.headers.get('link') || '';
  const { products } = await r.json();
  allProducts.push(...(products || []));
  const next = link.match(/<([^>]+)>;\s*rel="next"/);
  url = next ? next[1] : null;
  if (url) await sleep(550);
}

console.log(`Found ${allProducts.length} products, ${allProducts.reduce((s,p)=>s+p.variants.length,0)} total variants\n`);

// ── Analyse current state ─────────────────────────────────────────────────────

let soldOutVariants = 0, wrongPolicy = 0, alreadyDiscounted = 0, notDiscounted = 0;
for (const p of allProducts) {
  for (const v of p.variants) {
    if (v.inventory_quantity <= 0) soldOutVariants++;
    if (v.inventory_policy !== 'continue') wrongPolicy++;
    if (v.compare_at_price && parseFloat(v.compare_at_price) > parseFloat(v.price)) alreadyDiscounted++;
    else notDiscounted++;
  }
}

console.log('Current state:');
console.log(`  Variants with qty ≤ 0: ${soldOutVariants}`);
console.log(`  Variants with policy ≠ continue: ${wrongPolicy}`);
console.log(`  Variants already discounted: ${alreadyDiscounted}`);
console.log(`  Variants needing 50% pricing: ${notDiscounted}\n`);

// ── Build variant updates ─────────────────────────────────────────────────────

let invUpdated = 0, priceUpdated = 0, skipped = 0, errors = 0;
const total = allProducts.length;

for (let i = 0; i < allProducts.length; i++) {
  const p = allProducts[i];
  process.stdout.write(`  [${i+1}/${total}] ${p.title.slice(0,50)}\r`);

  const updatedVariants = [];
  let productNeedsUpdate = false;

  for (const v of p.variants) {
    const variantUpdate = { id: v.id };
    let changed = false;

    // ── Inventory policy fix ─────────────────────────────────────────────
    if (DO_INV && v.inventory_policy !== 'continue') {
      variantUpdate.inventory_policy = 'continue';
      changed = true;
    }

    // ── 50% pricing ──────────────────────────────────────────────────────
    if (DO_PRICING) {
      const currentPrice = parseFloat(v.price);
      const currentCompare = parseFloat(v.compare_at_price || 0);

      // Only apply if not already correctly discounted
      // Correctly discounted = compare_at_price is ~2× the current price
      const isAlreadyHalfPrice = currentCompare > 0 && Math.abs(currentCompare / currentPrice - 2) < 0.05;

      if (!isAlreadyHalfPrice && currentPrice > 0) {
        const salePrice  = (currentPrice * 0.5).toFixed(2);
        const origPrice  = currentPrice.toFixed(2);
        variantUpdate.price             = salePrice;
        variantUpdate.compare_at_price  = origPrice;
        changed = true;
      }
    }

    if (changed) {
      updatedVariants.push(variantUpdate);
      productNeedsUpdate = true;
    }
  }

  if (!productNeedsUpdate) {
    skipped++;
    continue;
  }

  if (DRY) {
    const sample = updatedVariants[0];
    const pricePart = sample.price ? ` | price: ${allProducts[i].variants[0].price} → ${sample.price} (was: ${sample.compare_at_price})` : '';
    const invPart   = sample.inventory_policy ? ` | policy: → ${sample.inventory_policy}` : '';
    console.log(`\n  [DRY] ${p.title.slice(0,55)}${pricePart}${invPart}`);
    invUpdated   += DO_INV     ? updatedVariants.length : 0;
    priceUpdated += DO_PRICING ? updatedVariants.length : 0;
    continue;
  }

  // Apply via product update (batch all variants in one PUT)
  const result = await put(`/products/${p.id}.json`, {
    product: {
      id: p.id,
      variants: updatedVariants,
    }
  });

  if (result.product) {
    invUpdated   += DO_INV     ? updatedVariants.length : 0;
    priceUpdated += DO_PRICING ? updatedVariants.length : 0;
  } else {
    console.error(`\n  ❌ Error on "${p.title.slice(0,40)}":`, result.errors || JSON.stringify(result).slice(0,100));
    errors++;
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n\n══ COMPLETE ══════════════════════════════════════════════════`);
if (DRY) {
  console.log(`\n  DRY RUN — ${allProducts.length} products, ~${wrongPolicy} inventory fixes, ~${notDiscounted} price updates needed`);
  console.log('  Run with --apply to execute\n');
} else {
  console.log(`
  Inventory policies updated:  ${invUpdated} variants → continue (no more Sold Out)
  Prices updated:              ${priceUpdated} variants → 50% sale with compare_at_price
  Skipped (already correct):   ${skipped} products
  Errors:                      ${errors}

  Verify at: https://${SHOP}/collections/all
`);
}
