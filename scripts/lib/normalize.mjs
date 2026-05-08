/**
 * Y2KASE ETL — Extraction / Normalisation
 *
 * Shared between the CLI import script (etsy-api-import.mjs) and the
 * dashboard server (scripts/dashboard/server.mjs).  Kept in a separate
 * module so the dashboard can import normalizeEtsyRecord without also
 * importing the CLI's main() function (which would execute immediately).
 *
 * Zero external dependencies — pure CSV-row → EtsyProduct conversion.
 *
 * Style extraction from the description column is handled EXCLUSIVELY by
 * the LLM enrichment layer (scripts/lib/llm-enrich.mjs).  normalizeEtsyRecord
 * sets stylesFromDescription / stylesInferred to [] — the enrichment step in
 * server.mjs populates them asynchronously before the transform runs.
 */

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

// ── Canonical style ordering ──────────────────────────────────────────────────
// Shopify variant option values are displayed in the order they appear in the
// productOptions array.  Sorting to this order ensures all products present
// variants in the same sequence regardless of how the description listed them.

export const CANONICAL_STYLE_ORDER = [
  'Case+Grip+Charm',
  'Case+Grip',
  'Case+Charm',
  'Case Only',
  'Grip Only',
  'Charm Only',
  'Case+Strap',
  'Strap Only',
];

/**
 * Apply component-modularity inference to fill logical gaps in an LLM-extracted
 * style array, then sort to canonical Shopify option order.
 *
 * PRINCIPLE:
 *   If a component (grip or charm) is sold as a modular add-on bundled with
 *   the case — evidenced by a "Case+Grip" or "Case+Charm" variant — it MUST
 *   also be available as a standalone SKU.  When the standalone variant is
 *   absent it is a description omission, not an intentional product decision.
 *
 * Rule 1 — Infer Grip Only:
 *   "Case+Grip" present AND "Grip Only" absent → add "Grip Only"
 *
 * Rule 2 — Infer Charm Only:
 *   "Case+Charm" present AND "Charm Only" absent → add "Charm Only"
 *
 * @param {string[]} llmStyles  Raw style array from the LLM extraction.
 * @returns {{ styles: string[], inferred: string[] }}
 *   styles   — augmented + canonically sorted style array.
 *   inferred — names of styles added by inference ([] when none needed).
 */
export function inferMissingBundleStyles(llmStyles) {
  const result   = [...llmStyles];
  const inferred = [];

  if (llmStyles.includes('Case+Grip') && !llmStyles.includes('Grip Only')) {
    result.push('Grip Only');
    inferred.push('Grip Only');
  }

  if (llmStyles.includes('Case+Charm') && !llmStyles.includes('Charm Only')) {
    result.push('Charm Only');
    inferred.push('Charm Only');
  }

  result.sort((a, b) => {
    const ai = CANONICAL_STYLE_ORDER.indexOf(a);
    const bi = CANONICAL_STYLE_ORDER.indexOf(b);
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
  });

  return { styles: result, inferred };
}

/**
 * Normalise one raw Etsy CSV record into a structured EtsyProduct object.
 * Pure extraction — no classification, title-rewriting, or API calls.
 *
 * stylesFromDescription and stylesInferred are initialised to [] here.
 * They are populated by the async LLM enrichment step in server.mjs
 * (enrichProductStyles) before buildShopifyPayload runs.
 *
 * @param {Object} raw - one record yielded by parseCsvFile()
 * @returns {EtsyProduct}
 *
 * @typedef {object} EtsyProduct
 * @property {string}   title
 * @property {string}   description            raw DESCRIPTION column value
 * @property {string}   price                  numeric string, e.g. "85.00"
 * @property {string}   currency               e.g. "HKD"
 * @property {number}   quantity
 * @property {string[]} tags
 * @property {string[]} materials
 * @property {string[]} images                 absolute URLs
 * @property {string[]} models                 VARIATION 1 VALUES, split on comma
 * @property {string[]} styles                 VARIATION 2 VALUES, split on comma
 * @property {string[]} stylesFromDescription  LLM-extracted + inferred styles;
 *                                             always [] until enrichment runs.
 * @property {string[]} stylesInferred         styles added by inferMissingBundleStyles;
 *                                             always [] until enrichment runs.
 * @property {string}   etsySku
 */
export function normalizeEtsyRecord(raw) {
  const description = (raw['DESCRIPTION'] ?? '').trim();
  return {
    title:                 (raw['TITLE']         ?? '').trim(),
    description,
    price:                 (raw['PRICE']         ?? '0').trim(),
    currency:              (raw['CURRENCY_CODE'] ?? 'HKD').trim(),
    quantity:              parseInt(raw['QUANTITY'] ?? '0', 10) || 0,
    tags:                  splitAndTrim(raw['TAGS']),
    materials:             splitAndTrim(raw['MATERIALS']),
    images:                extractImages(raw),
    models:                splitAndTrim(raw['VARIATION 1 VALUES']),
    styles:                splitAndTrim(raw['VARIATION 2 VALUES']),
    stylesFromDescription: [],
    stylesInferred:        [],
    etsySku:               (raw['SKU'] ?? '').trim(),
  };
}
