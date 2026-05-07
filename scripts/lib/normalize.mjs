/**
 * Y2KASE ETL — Extraction / Normalisation
 *
 * Shared between the CLI import script (etsy-api-import.mjs) and the
 * dashboard server (scripts/dashboard/server.mjs).  Kept in a separate
 * module so the dashboard can import normalizeEtsyRecord without also
 * importing the CLI's main() function (which would execute immediately).
 *
 * Zero external dependencies — pure CSV-row → EtsyProduct conversion.
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

/**
 * Normalise one raw Etsy CSV record into a structured EtsyProduct object.
 * Pure extraction — no classification, title-rewriting, or API calls.
 *
 * @param {Object} raw - one record yielded by parseCsvFile()
 * @returns {EtsyProduct}
 *
 * @typedef {object} EtsyProduct
 * @property {string}   title
 * @property {string}   description
 * @property {string}   price         numeric string, e.g. "85.00"
 * @property {string}   currency      e.g. "HKD"
 * @property {number}   quantity
 * @property {string[]} tags
 * @property {string[]} materials
 * @property {string[]} images        absolute URLs
 * @property {string[]} models        VARIATION 1 VALUES, split on comma
 * @property {string[]} styles        VARIATION 2 VALUES, split on comma
 * @property {string}   etsySku
 */
export function normalizeEtsyRecord(raw) {
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
