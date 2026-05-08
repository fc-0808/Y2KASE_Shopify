/**
 * Y2KASE Phase 3 — Transformation Layer
 *
 * Converts a normalised EtsyProduct into a Shopify productSet input payload.
 *
 * Pipeline per product:
 *   1. Classify   — detect type, device, characters, styles, aesthetics (classifier.mjs)
 *   2. Title      — rewrite keyword-stuffed Etsy title to clean ≤70-char title (title-generator.mjs)
 *   3. HTML body  — convert plain-text Etsy description to structured HTML
 *   4. Variants   — Cartesian(models × styles) with per-bundle dynamic pricing
 *   5. SKUs       — Y2K-[CHAR]-[MODEL]-[STYLE] per variant
 *   6. Metafields — original Etsy title + normalised tags → custom namespace
 *   7. SEO        — clean title + 155-char description
 *
 * The returned object maps 1-to-1 onto Shopify's ProductSetInput GraphQL type.
 * Fields prefixed with _ are pipeline metadata (not sent to the API directly).
 */

import { classifyProduct }                  from '../taxonomy/classifier.mjs';
import { generateTitle, needsTitleRewrite } from '../taxonomy/title-generator.mjs';

// ── Smart-fallback constants ───────────────────────────────────────────────────
// Used when Etsy variation columns are absent or unrecognised.

/**
 * Canonical 6-bundle style list.
 * Triggered when the raw Etsy title signals a MagSafe listing but the
 * VARIATION 2 VALUES column is empty or contains only unrecognised values.
 */
const MAGSAFE_STYLES_FALLBACK = [
  'Case+Grip+Charm',
  'Case+Grip',
  'Case+Charm',
  'Case Only',
  'Grip Only',
  'Charm Only',
];

/**
 * Standard 12-model iPhone lineup used as the Models fallback when
 * VARIATION 1 VALUES is completely empty.
 * Mirrors the authoritative MODEL_SKU_CODE keys (defined below).
 */
const MODELS_FALLBACK = [
  'iPhone 17 Pro Max',
  'iPhone 17 Pro',
  'iPhone 17',
  'iPhone 16 Pro Max',
  'iPhone 16 Pro',
  'iPhone 16',
  'iPhone 15 Pro Max',
  'iPhone 15 Pro',
  'iPhone 15',
  'iPhone 14 Pro Max',
  'iPhone 14 Pro',
  'iPhone 14/13',
];

// ── Price matrix ──────────────────────────────────────────────────────────────
// Authoritative per-bundle prices (HKD).
// Applied when the style string does NOT embed a price in parentheses.

const STYLE_PRICES = {
  'Case+Grip+Charm': 409.89,
  'Case+Grip':       350.11,
  'Case+Charm':      350.11,
  'Case Only':       261.86,
  'Grip Only':       170.76,
  'Charm Only':      113.82,
};

// ── SKU code tables ───────────────────────────────────────────────────────────

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

const STYLE_SKU_CODE = {
  'Case+Grip+Charm': 'CGC',
  'Case+Grip':       'CG',
  'Case+Charm':      'CC',
  'Case Only':       'CO',
  'Grip Only':       'GO',
  'Charm Only':      'CHO',
};

// Character code for SKU generation — matched against lowercase product title
const CHAR_CODE_MAP = [
  // Must be ordered longest-match-first within overlapping terms
  ['my sweet piano', 'MSPE'],
  ['my melody',      'MMLD'],
  ['hello kitty',    'HKTY'],
  ['little twin stars', 'LTST'],
  ['tuxedo sam',     'TXSM'],
  ['badtz-maru',     'BTZM'],
  ['badtz maru',     'BTZM'],
  ['wish me mell',   'WMML'],
  ['winnie the pooh','POOH'],
  ['winnie',         'POOH'],
  ['judy hopps',     'JUDY'],
  ['zootopia',       'ZOOT'],
  ['maneki neko',    'MNKN'],
  ['lucky cat',      'MNKN'],
  ['sleepy star',    'SLPY'],
  ['tamagotchi',     'TAMA'],
  ['monchhichi',     'MNCH'],
  ['rilakkuma',      'RLKM'],
  ['korilakkuma',    'RLKM'],
  ['sumikko',        'SMKK'],
  ['charmmy',        'CHRY'],
  ['cinnamoroll',    'CNNM'],
  ['pompompurin',    'PPPR'],
  ['pochacco',       'PCHO'],
  ['keroppi',        'KRPP'],
  ['hangyodon',      'HGDN'],
  ['cogimyun',       'CGMN'],
  ['aggretsuko',     'RTKK'],
  ['gudetama',       'GDTE'],
  ['cinnamoangels',  'CNAG'],
  ['kuromi',         'KRMI'],
  ['chiikawa',       'CHKW'],
  ['hatsune miku',   'MIKU'],
  ['vocaloid',       'MIKU'],
  ['sailor moon',    'SLMN'],
  ['cardcaptor',     'CCSN'],
  ['tokyo mew mew',  'TMWM'],
  ['precure',        'PCRE'],
  ['totoro',         'GHBL'],
  ['ghibli',         'GHBL'],
  ['spirited away',  'GHBL'],
  ['jujutsu kaisen', 'JJKS'],
  ['demon slayer',   'DMSL'],
  ['blue archive',   'BLAR'],
  ['pikachu',        'PKMN'],
  ['pokemon',        'PKMN'],
  ['mickey',         'MCKY'],
  ['minnie',         'MCKY'],
  ['stitch',         'STTC'],
  ['sleeping beauty','SLBT'],
  ['alice',          'ALCW'],
  ['bambi',          'BMBI'],
  ['dumbo',          'DMBO'],
  ['snoopy',         'SNPY'],
  ['sanrio',         'SNRO'],
];

// ── Regex for embedded price in style option strings ──────────────────────────
// Matches:  "Case+Grip+Charm (HKD 409.89)"
//           "Case Only (204.94)"
//           "Grip Only ( USD 170.76 )"
const EMBEDDED_PRICE_RE = /^(.+?)\s*\(\s*(?:[A-Z]{3}\s*)?([\d,]+\.?\d*)\s*\)$/i;

// ── Pure helpers ──────────────────────────────────────────────────────────────

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
}

function getCharCode(title) {
  const lower = title.toLowerCase();
  for (const [key, code] of CHAR_CODE_MAP) {
    if (lower.includes(key)) return code;
  }
  return 'MISC';
}

/**
 * Parse a raw style option value that may embed a price in parentheses.
 *
 * Priority order:
 *   1. Embedded price  → "Case+Grip+Charm (HKD 409.89)"
 *   2. STYLE_PRICES matrix → exact match on style name
 *   3. CSV base price fallback (should never reach this for known bundles)
 *
 * @param {string} rawStyle      - e.g. "Case+Grip+Charm (HKD 409.89)" or "Case Only"
 * @param {string} basePriceStr  - CSV PRICE field as numeric string fallback
 * @returns {{ styleName: string, price: number }}
 */
function parseStyleAndPrice(rawStyle, basePriceStr) {
  const match = rawStyle.match(EMBEDDED_PRICE_RE);
  if (match) {
    return {
      styleName: match[1].trim(),
      price:     parseFloat(match[2].replace(',', '')),
    };
  }
  const styleName = rawStyle.trim();
  const matrixPrice = STYLE_PRICES[styleName];
  if (matrixPrice !== undefined) {
    return { styleName, price: matrixPrice };
  }
  // Unknown style — warn and fall back to base CSV price
  console.warn(`  [WARN] Unknown style "${styleName}" — no matrix price, falling back to CSV base price`);
  return { styleName, price: parseFloat(basePriceStr) || 0 };
}

/**
 * Convert Etsy plain-text description to structured HTML.
 * Logic ported from etsy-to-shopify-csv.mjs — kept in sync with that source.
 *
 * Rules:
 *  - Double newlines → paragraph breaks
 *  - Short lines without colons → <strong> subheadings
 *  - Lines with colons in a block → <ul><li> list items
 *  - Everything else → <p> paragraphs with <br> for single newlines
 */
function descToHtml(raw) {
  if (!raw) return '';

  const EMOJI_PREFIX_RE = /^[\u{1F000}-\u{1FFFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\s]+/u;
  const blocks = raw.split(/\n{2,}/);
  const parts  = [];

  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    if (lines.length === 1) {
      const line = lines[0];
      if (line.length < 60 && !line.includes(':')) {
        const clean = line.replace(EMOJI_PREFIX_RE, '').trim();
        parts.push(`<p><strong>${clean || line}</strong></p>`);
      } else {
        parts.push(`<p>${line}</p>`);
      }
    } else {
      const first     = lines[0];
      const rest      = lines.slice(1);
      const isHeader  = first.length < 60 && !first.includes(':');

      if (isHeader) {
        const clean  = first.replace(EMOJI_PREFIX_RE, '').trim();
        const header = `<p><strong>${clean || first}</strong></p>`;
        if (rest.every(l => l.includes(':'))) {
          parts.push(`${header}<ul>${rest.map(l => `<li>${l}</li>`).join('')}</ul>`);
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

/**
 * Build a ≤155-char SEO meta description.
 *
 * @param {string} shopifyTitle
 * @param {object} classification - output from classifyProduct()
 * @returns {string}
 */
function buildSeoDescription(shopifyTitle, classification) {
  const type = classification.shopifyProductType;
  const base = `Shop the ${shopifyTitle} at Y2KASE — kawaii ${type} with worldwide shipping.`;
  return base.length <= 155 ? base : base.slice(0, 152) + '...';
}

/**
 * Build Shopify metafields array for the custom namespace.
 *
 * Metafields created:
 *  custom.etsy_original_title  — keyword-stuffed title preserved for long-tail SEO
 *  custom.seo_keywords         — normalised Etsy tags as comma-separated keyword list
 *
 * @param {object} etsyProduct
 * @param {string} shopifyTitle - the generated clean title
 * @returns {Array<MetafieldInput>}
 */
function buildMetafields(etsyProduct, shopifyTitle) {
  const mf = [];

  // Store original Etsy title only when it differs from the rewritten title.
  // Long-tail keyword phrases in the original have measurable organic search value.
  if (etsyProduct.title !== shopifyTitle) {
    mf.push({
      namespace: 'custom',
      key:       'etsy_original_title',
      value:     etsyProduct.title,
      type:      'single_line_text_field',
    });
  }

  // Normalise raw Etsy tags: underscores → spaces, dedup, strip noise
  const NOISE_TAGS = new Set([
    'y2kase', 'gift for her', 'cute iphone case', 'iphone 17 pro max',
    'iphone case gift', 'iphone case',
  ]);
  const keywords = [
    ...new Set(
      etsyProduct.tags
        .map(t => t.replace(/_/g, ' ').toLowerCase().trim())
        .filter(t => t.length > 2 && !NOISE_TAGS.has(t))
    ),
  ].join(', ');

  if (keywords) {
    mf.push({
      namespace: 'custom',
      key:       'seo_keywords',
      value:     keywords,
      type:      'multi_line_text_field',
    });
  }

  return mf;
}

/**
 * Determine whether a styles array is "generic" — i.e. it is either empty or
 * every entry fails to match any key in STYLE_PRICES after stripping an
 * embedded-price suffix.  Generic arrays do not contribute useful Cartesian
 * data and are safe to replace with a smart fallback.
 *
 * @param {string[]} styles
 * @returns {boolean}
 */
function isGenericStyles(styles) {
  if (styles.length === 0) return true;
  return styles.every(raw => {
    const match = raw.match(EMBEDDED_PRICE_RE);
    const name  = match ? match[1].trim() : raw.trim();
    return !(name in STYLE_PRICES);
  });
}

/**
 * Apply smart-fallback rules to a normalised EtsyProduct and return a
 * patched copy.  The original object is never mutated.
 *
 * Rule 1 — MagSafe style override
 *   Condition: styles are empty/generic AND the raw Etsy title matches
 *              /magsafe/i or /max\s*save/i
 *   Action:    Replace styles with MAGSAFE_STYLES_FALLBACK (6 canonical bundles)
 *
 * Rule 2 — Model fallback
 *   Condition: models array is empty
 *   Action:    Replace models with MODELS_FALLBACK (top 12 iPhone lineup)
 *
 * Both rules are independent and may fire together.
 *
 * @param {import('../lib/normalize.mjs').EtsyProduct} product
 * @returns {{ product: EtsyProduct, fallbacksApplied: string[] }}
 */
function resolveVariations(product) {
  const fallbacksApplied = [];

  let { models, styles } = product;

  // Rule 1: MagSafe / "max save" title → canonical 6-bundle styles
  if (isGenericStyles(styles) && /magsafe|max\s*save/i.test(product.title)) {
    console.info(
      `  [FALLBACK] Styles → MagSafe 6-bundle set  (title: "${product.title.slice(0, 60)}…")`
    );
    styles = MAGSAFE_STYLES_FALLBACK;
    fallbacksApplied.push('styles:magsafe');
  }

  // Rule 2: Missing models → standard 12-model lineup
  if (models.length === 0) {
    console.info(
      `  [FALLBACK] Models → standard 12-model lineup  (title: "${product.title.slice(0, 60)}…")`
    );
    models = MODELS_FALLBACK;
    fallbacksApplied.push('models:default');
  }

  return {
    product:          { ...product, models, styles },
    fallbacksApplied,
  };
}

/**
 * Build the Cartesian variant matrix: every unique (model × style) combination.
 *
 * Each variant receives:
 *  - Correct bundle price (embedded > matrix > CSV fallback)
 *  - Unique structured SKU: Y2K-[CHAR]-[MODEL]-[STYLE]
 *  - inventoryItem.tracked = true  (equivalent to inventoryManagement: 'SHOPIFY')
 *  - inventoryPolicy: DENY         (prevent overselling)
 *
 * @param {object} etsyProduct
 * @param {object} classification
 * @returns {Array<ProductVariantsBulkInput>}
 */
function buildVariants(etsyProduct, classification) {
  const charCode = getCharCode(etsyProduct.title);
  const variants = [];

  for (const model of etsyProduct.models) {
    for (const rawStyle of etsyProduct.styles) {
      const { styleName, price } = parseStyleAndPrice(rawStyle, etsyProduct.price);

      const modelCode = MODEL_SKU_CODE[model]
        ?? model.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase();
      const styleCode = STYLE_SKU_CODE[styleName]
        ?? styleName.replace(/[^a-zA-Z0-9+]/g, '').slice(0, 4).toUpperCase();

      variants.push({
        optionValues: [
          { optionName: 'Phone Model', name: model },
          { optionName: 'Style',       name: styleName },
        ],
        price:            price.toFixed(2),
        sku:              `Y2K-${charCode}-${modelCode}-${styleCode}`,
        inventoryPolicy:  'DENY',
        inventoryItem:    { tracked: true },
        requiresShipping: true,
        taxable:          true,
        weight:           0,
        weightUnit:       'GRAMS',
      });
    }
  }

  return variants;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Transform a normalised EtsyProduct into a Shopify productSet input payload.
 *
 * @param {object} etsyProduct - output of normalizeEtsyRecord() from etsy-api-import.mjs
 * @returns {ShopifyProductPayload}
 *
 * @typedef {object} ShopifyProductPayload
 * Fields matching ProductSetInput (sent to API):
 *  title, descriptionHtml, handle, vendor, productType, status,
 *  tags, seo, metafields, productOptions, variants
 * Pipeline metadata fields (NOT sent to API directly):
 *  _images        — queued for productCreateMedia call after product creation
 *  _inventoryQty  — passed to inventorySetOnHandQuantities after product creation
 *  _meta          — debug/audit info (etsyTitle, classification, variantCount)
 */
export function buildShopifyPayload(etsyProduct) {
  // ── Step 0: Smart-fallback resolution ─────────────────────────────────────
  // Patch missing / unrecognised variation data before any downstream work.
  const { product: p, fallbacksApplied } = resolveVariations(etsyProduct);

  // ── Step 1: Classify ───────────────────────────────────────────────────────
  const classification = classifyProduct({
    title:    p.title,
    // Normalise tag underscores before passing to classifier — it does string matching
    tags:     p.tags.map(t => t.replace(/_/g, ' ')).join(', '),
    variants: p.models.map(m => ({ title: m })),
  });

  // ── Step 2: Title rewrite ──────────────────────────────────────────────────
  const shopifyTitle = needsTitleRewrite(p.title)
    ? generateTitle(classification)
    : p.title;

  // ── Step 3: Variant matrix ─────────────────────────────────────────────────
  const variants = buildVariants(p, classification);

  // ── Step 4: Deduplicated style option values (strip any embedded price text)
  const styleOptionValues = [
    ...new Map(
      p.styles.map(s => {
        const { styleName } = parseStyleAndPrice(s, p.price);
        return [styleName, { name: styleName }];
      })
    ).values(),
  ];

  // ── Step 5: Assemble full payload ──────────────────────────────────────────
  return {
    // ── Fields sent to productSet mutation ────────────────────────────────────
    title:           shopifyTitle,
    descriptionHtml: descToHtml(p.description),
    handle:          slugify(shopifyTitle),
    vendor:          'Y2KASE',
    productType:     classification.shopifyProductType,
    status:          'DRAFT',
    tags:            classification.finalTags,

    seo: {
      title:       shopifyTitle,
      description: buildSeoDescription(shopifyTitle, classification),
    },

    metafields: buildMetafields(p, shopifyTitle),

    productOptions: [
      {
        name:   'Phone Model',
        values: p.models.map(m => ({ name: m })),
      },
      {
        name:   'Style',
        values: styleOptionValues,
      },
    ],

    variants,

    // ── Phase 4 pipeline metadata (not in ProductSetInput) ───────────────────

    // Image URLs to push via productCreateMedia after the product is created
    _images: p.images.map((src, i) => ({
      src,
      alt:      shopifyTitle,
      position: i + 1,
    })),

    // Stock quantity — applied via inventorySetOnHandQuantities after creation
    _inventoryQty: Math.max(p.quantity || 0, 3),

    // Audit metadata — useful for dry-run display and post-import reports
    _meta: {
      etsyTitle:       p.title,
      variantCount:    variants.length,
      // Non-empty when one or both smart-fallback rules fired for this product
      fallbacksApplied: fallbacksApplied.length ? fallbacksApplied : undefined,
      classification: {
        productType: classification.productType,
        deviceBrand: classification.deviceBrand,
        attachment:  classification.attachment,
        characters:  classification.characters,
        ipBrands:    classification.ipBrands,
        styles:      classification.styles,
        aesthetics:  classification.aesthetics,
        features:    classification.features,
      },
    },
  };
}
