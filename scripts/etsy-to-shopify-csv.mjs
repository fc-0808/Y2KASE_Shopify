/**
 * etsy-to-shopify-csv.mjs
 *
 * Transforms EtsyListingsDownload.csv → shopify-import.csv
 *
 * What it does:
 *   - Parses the Etsy CSV export (multi-line quoted fields supported)
 *   - Explodes each product into 12 Phone Model × 6 Style = 72 variant rows
 *   - Applies the confirmed per-style price matrix (from Etsy listing inspection)
 *   - Sets qty = 3 per variant combination (all products)
 *   - Generates structured SKUs: Y2K-[CHAR]-[MODEL]-[STYLE]
 *   - Converts Etsy description to basic HTML paragraphs
 *   - Outputs in Shopify product import CSV format, status=draft
 *
 * Usage:
 *   node scripts/etsy-to-shopify-csv.mjs
 *
 * Output:
 *   shopify-import.csv  (in project root, ready to upload via Shopify Admin)
 *
 * NOTE: Titles are carried over from Etsy as-is. Run Phase 01 SEO rewrite
 * before the final import — update the Title and SEO Title columns.
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');

// ── Config ────────────────────────────────────────────────────────────────────

const INPUT_FILE  = resolve(ROOT, 'EtsyListingsDownload.csv');
const OUTPUT_FILE = resolve(ROOT, 'shopify-import.csv');

const VENDOR       = 'Y2KASE';
const PRODUCT_TYPE = 'Phone Case';
const VARIANT_QTY  = 3;

/** Per-style prices confirmed from Etsy listing variation screen (HKD). */
const STYLE_PRICES = {
  'Case+Grip+Charm': 409.89,
  'Case+Grip':       350.11,
  'Case+Charm':      350.11,
  'Case Only':       261.86,
  'Grip Only':       170.76,
  'Charm Only':      113.82,
};

/** Compact codes for Phone Model option values → used in SKU. */
const MODEL_SKU_CODE = {
  'iPhone 17 Pro Max': '17PM',
  'iPhone 17 Pro':     '17PR',
  'iPhone 17':         '17',
  'iPhone 16 Pro Max': '16PM',
  'iPhone 16 Pro':     '16PR',
  'iPhone 16':         '16',
  'iPhone 15 Pro Max': '15PM',
  'iPhone 15 Pro':     '15PR',
  'iPhone 15':         '15',
  'iPhone 14 Pro Max': '14PM',
  'iPhone 14 Pro':     '14PR',
  'iPhone 14/13':      '1413',
};

/** Compact codes for Style option values → used in SKU. */
const STYLE_SKU_CODE = {
  'Case+Grip+Charm': 'CGC',
  'Case+Grip':       'CG',
  'Case+Charm':      'CC',
  'Case Only':       'CO',
  'Grip Only':       'GO',
  'Charm Only':      'CHO',
};

/** Character code lookup — matched against lower-cased product title. */
const CHAR_CODE_MAP = [
  ['winnie',        'POOH'],
  ['snoopy',        'SNPY'],
  ['tamagotchi',    'TAMA'],
  ['monchhichi',    'MNCH'],
  ['rilakkuma',     'RLKM'],
  ['sumikko',       'SMKK'],
  ['zootopia',      'ZOOT'],
  ['chiikawa',      'CHKW'],
  ['sleepy star',   'SLPY'],
  ['my sweet piano','MSPE'],
  ['charmmy',       'CHRY'],
  ['cinnamoroll',   'CNNM'],
  ['kuromi',        'KRMI'],
  ['my melody',     'MMLD'],
  ['maneki neko',   'MNKN'],
  ['hello kitty',   'HKTY'],
  ['sanrio',        'SNRO'],
  ['strawberry',    'STRW'],
  ['apple',         'APPL'],
  ['plush',         'PLSH'],
];

/** Shopify product import CSV columns in required order. */
const SHOPIFY_HEADERS = [
  'Handle',
  'Title',
  'Body (HTML)',
  'Vendor',
  'Product Category',
  'Type',
  'Tags',
  'Published',
  'Option1 Name',
  'Option1 Value',
  'Option2 Name',
  'Option2 Value',
  'Variant SKU',
  'Variant Grams',
  'Variant Inventory Tracker',
  'Variant Inventory Qty',
  'Variant Inventory Policy',
  'Variant Fulfillment Service',
  'Variant Price',
  'Variant Requires Shipping',
  'Variant Taxable',
  'Image Src',
  'Image Position',
  'Image Alt Text',
  'SEO Title',
  'SEO Description',
  'Google Shopping / Google Product Category',
  'Status',
];

// ── CSV parser ────────────────────────────────────────────────────────────────
// Full character-by-character parser — handles multi-line quoted fields.

function parseCSV(text) {
  const rawRows = [];
  let row       = [];
  let field     = '';
  let inQuotes  = false;

  for (let i = 0; i < text.length; i++) {
    const ch   = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\r' && next === '\n') {
        row.push(field);
        field = '';
        rawRows.push(row);
        row = [];
        i++;
      } else if (ch === '\n') {
        row.push(field);
        field = '';
        rawRows.push(row);
        row = [];
      } else {
        field += ch;
      }
    }
  }

  // Flush last field / row
  if (field || row.length > 0) {
    row.push(field);
    rawRows.push(row);
  }

  if (rawRows.length === 0) return [];

  const headers = rawRows[0];
  const records = [];

  for (let i = 1; i < rawRows.length; i++) {
    if (rawRows[i].every(c => c === '')) continue;
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = rawRows[i][idx] ?? ''; });
    records.push(obj);
  }

  return records;
}

// ── CSV serializer ────────────────────────────────────────────────────────────

function escapeField(val) {
  const s = val === null || val === undefined ? '' : String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function serializeRow(obj, headers) {
  return headers.map(h => escapeField(obj[h] ?? '')).join(',');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 200);
}

function getCharCode(title) {
  const lower = title.toLowerCase();
  for (const [key, code] of CHAR_CODE_MAP) {
    if (lower.includes(key)) return code;
  }
  return 'MISC';
}

/**
 * Converts Etsy plain-text description to clean HTML.
 * Paragraphs are separated by double newlines.
 * Lines with a short header pattern (emoji leader, short text, no colon)
 * become <strong> labels. "Key: value" lines become list items.
 */
function descToHtml(raw) {
  const blocks = raw.split(/\n{2,}/);
  const parts  = [];

  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    if (lines.length === 1) {
      const line = lines[0];
      // Short line with no colon — treat as a section sub-heading
      if (line.length < 60 && !line.includes(':')) {
        // Strip leading emoji/symbol characters
        const clean = line.replace(/^[\u{1F000}-\u{1FFFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\s]+/u, '').trim();
        parts.push(`<p><strong>${clean || line}</strong></p>`);
      } else {
        parts.push(`<p>${line}</p>`);
      }
    } else {
      // Multi-line block — check if first line looks like a header
      const first = lines[0];
      const rest  = lines.slice(1);
      const isHeader = first.length < 60 && !first.includes(':');

      if (isHeader) {
        const clean = first.replace(/^[\u{1F000}-\u{1FFFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\s]+/u, '').trim();
        const header = `<p><strong>${clean || first}</strong></p>`;
        // Remaining lines — list if they contain colons, paragraphs otherwise
        const hasColons = rest.every(l => l.includes(':'));
        if (hasColons) {
          const items = rest.map(l => `<li>${l}</li>`).join('');
          parts.push(`${header}<ul>${items}</ul>`);
        } else {
          parts.push(`${header}<p>${rest.join('<br>')}</p>`);
        }
      } else {
        parts.push(`<p>${lines.join('<br>')}</p>`);
      }
    }
  }

  return parts.join('\n');
}

/** Build a placeholder SEO title (≤70 chars). Phase 01 will replace these. */
function buildSeoTitle(title) {
  // Strip the trailing iPhone model list that Etsy appends
  const clean = title
    .replace(/,?\s*iphone\s[\d\s/a-z]+(?:pro max|pro)?[\w\s,]*/gi, '')
    .replace(/,\s*$/, '')
    .trim();
  return clean.length <= 70 ? clean : clean.substring(0, 67) + '...';
}

/** Build a placeholder SEO description (≤155 chars). Phase 01 will replace. */
function buildSeoDesc(title) {
  const base = `Shop the ${buildSeoTitle(title)} at Y2KASE — kawaii Y2K phone cases for iPhone.`;
  return base.length <= 155 ? base : base.substring(0, 152) + '...';
}

// ── Main ──────────────────────────────────────────────────────────────────────

const raw      = readFileSync(INPUT_FILE, 'utf-8');
const products = parseCSV(raw);

const outputLines  = [SHOPIFY_HEADERS.join(',')];
const handlesSeen  = new Map(); // track handle → count for de-duplication

let totalProducts = 0;
let totalVariants  = 0;
let totalImageRows = 0;

for (let pIdx = 0; pIdx < products.length; pIdx++) {
  const p = products[pIdx];

  // ── Handle (unique) ────────────────────────────────────────────────────────
  const baseHandle = slugify(p.TITLE);
  const handleCount = handlesSeen.get(baseHandle) ?? 0;
  handlesSeen.set(baseHandle, handleCount + 1);
  const handle = handleCount === 0 ? baseHandle : `${baseHandle}-${handleCount + 1}`;

  // ── Character code for SKU ─────────────────────────────────────────────────
  const charCode = getCharCode(p.TITLE);

  // ── Variants ───────────────────────────────────────────────────────────────
  const models = p['VARIATION 1 VALUES'].split(',').map(v => v.trim()).filter(Boolean);
  const styles = p['VARIATION 2 VALUES'].split(',').map(v => v.trim()).filter(Boolean);

  const variants = [];
  for (const model of models) {
    for (const style of styles) {
      const modelCode = MODEL_SKU_CODE[model]
        ?? model.replace(/[^a-zA-Z0-9]/g, '').substring(0, 6).toUpperCase();
      const styleCode = STYLE_SKU_CODE[style]
        ?? style.replace(/[^a-zA-Z0-9]/g, '').substring(0, 4).toUpperCase();

      const price = STYLE_PRICES[style];
      if (price === undefined) {
        console.warn(`  [WARN] Unknown style "${style}" on product ${pIdx + 1} — price set to 0`);
      }

      variants.push({
        model,
        style,
        sku:   `Y2K-${charCode}-${modelCode}-${styleCode}`,
        price: (price ?? 0).toFixed(2),
      });
    }
  }

  // ── Images ─────────────────────────────────────────────────────────────────
  const images = [];
  for (let i = 1; i <= 10; i++) {
    const src = p[`IMAGE${i}`]?.trim();
    if (src) images.push(src);
  }

  // ── Tags ───────────────────────────────────────────────────────────────────
  const tags = p.TAGS
    .split(',')
    .map(t => t.trim().replace(/_/g, ' '))
    .filter(Boolean)
    .join(', ');

  // ── HTML body ──────────────────────────────────────────────────────────────
  const bodyHtml = descToHtml(p.DESCRIPTION);

  // ── SEO fields ─────────────────────────────────────────────────────────────
  const seoTitle = buildSeoTitle(p.TITLE);
  const seoDesc  = buildSeoDesc(p.TITLE);

  // ── First product row (includes product metadata + first variant) ──────────
  const firstV = variants[0];
  outputLines.push(serializeRow({
    'Handle':                                    handle,
    'Title':                                     p.TITLE,
    'Body (HTML)':                               bodyHtml,
    'Vendor':                                    VENDOR,
    'Product Category':                          'Accessories > Phone Cases',
    'Type':                                      PRODUCT_TYPE,
    'Tags':                                      tags,
    'Published':                                 'FALSE',
    'Option1 Name':                              'Phone Model',
    'Option1 Value':                             firstV.model,
    'Option2 Name':                              'Style',
    'Option2 Value':                             firstV.style,
    'Variant SKU':                               firstV.sku,
    'Variant Grams':                             '0',
    'Variant Inventory Tracker':                 'shopify',
    'Variant Inventory Qty':                     String(VARIANT_QTY),
    'Variant Inventory Policy':                  'deny',
    'Variant Fulfillment Service':               'manual',
    'Variant Price':                             firstV.price,
    'Variant Requires Shipping':                 'TRUE',
    'Variant Taxable':                           'TRUE',
    'Image Src':                                 images[0] ?? '',
    'Image Position':                            '1',
    'Image Alt Text':                            p.TITLE.substring(0, 512),
    'SEO Title':                                 seoTitle,
    'SEO Description':                           seoDesc,
    'Google Shopping / Google Product Category': 'Apparel & Accessories > Phone Cases',
    'Status':                                    'draft',
  }, SHOPIFY_HEADERS));

  // ── Remaining variant rows (Handle + variant columns only) ─────────────────
  for (let vIdx = 1; vIdx < variants.length; vIdx++) {
    const v = variants[vIdx];
    outputLines.push(serializeRow({
      'Handle':                    handle,
      'Option1 Value':             v.model,
      'Option2 Value':             v.style,
      'Variant SKU':               v.sku,
      'Variant Grams':             '0',
      'Variant Inventory Tracker': 'shopify',
      'Variant Inventory Qty':     String(VARIANT_QTY),
      'Variant Inventory Policy':  'deny',
      'Variant Fulfillment Service': 'manual',
      'Variant Price':             v.price,
      'Variant Requires Shipping': 'TRUE',
      'Variant Taxable':           'TRUE',
    }, SHOPIFY_HEADERS));
  }

  // ── Additional image rows (images 2–10) ────────────────────────────────────
  for (let imgIdx = 1; imgIdx < images.length; imgIdx++) {
    outputLines.push(serializeRow({
      'Handle':         handle,
      'Image Src':      images[imgIdx],
      'Image Position': String(imgIdx + 1),
      'Image Alt Text': p.TITLE.substring(0, 512),
    }, SHOPIFY_HEADERS));
    totalImageRows++;
  }

  totalProducts++;
  totalVariants += variants.length;
}

writeFileSync(OUTPUT_FILE, outputLines.join('\n'), 'utf-8');

console.log('');
console.log('  Etsy → Shopify CSV');
console.log('  ─────────────────────────────────────────────');
console.log(`  Products:        ${totalProducts}`);
console.log(`  Variants:        ${totalVariants}  (${totalVariants / totalProducts} avg per product)`);
console.log(`  Image rows:      ${totalImageRows}`);
console.log(`  Total CSV rows:  ${outputLines.length - 1}  (excl. header)`);
console.log(`  Output:          shopify-import.csv`);
console.log('');
console.log('  Price matrix applied:');
Object.entries(STYLE_PRICES).forEach(([style, price]) => {
  console.log(`    ${style.padEnd(18)} HKD ${price.toFixed(2)}`);
});
console.log('');
console.log('  Next: run Phase 01 SEO rewrite to update Title + SEO Title columns');
console.log('  Then: Shopify Admin > Products > Import > shopify-import.csv');
console.log('');
