/**
 * Y2KASE — Category Metafield Builder
 *
 * Translates the classifier output (from classifier.mjs) into Shopify
 * "category metafields" for the 4 attributes we are authorised to set
 * programmatically on the Mobile Phone Cases category.
 *
 * STRICTLY ALLOWED ATTRIBUTES (auto-settable via loader.mjs Step 4):
 *   shopify.material               — Thermoplastic polyurethane (TPU), etc.
 *   shopify.theme                  — Anime / Cartoons / Retro/Vintage / etc.
 *   shopify.attachment-options     — Magnet  (MagSafe products)
 *   shopify.connectivity-technology — (reserved; passive cases return nothing)
 *
 * All other shopify.* taxonomy attributes (case-type, magsafe-compatibility,
 * bag-case-material, finish, mobile-phone-case-features, etc.) return
 * APP_NOT_AUTHORIZED for private apps and must be filled manually in
 * Shopify Admin → Product → Category metafields.
 *
 * Metafield wire format (Shopify API 2026-04):
 *   namespace : "shopify"
 *   key       : attribute slug  e.g. "material"
 *   type      : "list.metaobject_reference"
 *   value     : JSON-encoded array of Metaobject GIDs
 *                  e.g. ["gid://shopify/Metaobject/12345"]
 *
 * GID source: .cache/taxonomy-metaobj-gid-cache.json
 *   Built by: node scripts/lib/discover-metaobj-gids.mjs <product-handle>
 *
 * If the cache has not been bootstrapped yet, buildCategoryMetafields()
 * returns an empty array.  Run the one-time bootstrap:
 *   1. Open any imported product in Shopify Admin
 *   2. Under "Category metafields", manually fill Material / Theme /
 *      Attachment options, then save.
 *   3. node scripts/lib/discover-metaobj-gids.mjs <that-product-handle>
 */

/** Keys for attributes we are authorised to set automatically. */
export const AUTO_SETTABLE_ATTRS = new Set([
  'material',
  'theme',
  'attachment-options',
  'connectivity-technology',
]);

import { existsSync, readFileSync } from 'fs';
import { resolve, dirname }         from 'path';
import { fileURLToPath }            from 'url';

const __dirname          = dirname(fileURLToPath(import.meta.url));
const METAOBJ_CACHE_PATH = resolve(__dirname, '../../.cache/taxonomy-metaobj-gid-cache.json');

let _mobjCache = null;

function getMobjCache() {
  if (_mobjCache !== null) return _mobjCache;
  if (existsSync(METAOBJ_CACHE_PATH)) {
    try { _mobjCache = JSON.parse(readFileSync(METAOBJ_CACHE_PATH, 'utf-8')); }
    catch { _mobjCache = { attributes: {} }; }
  } else {
    _mobjCache = { attributes: {} };
  }
  return _mobjCache;
}

// ── Metaobject GID resolver ───────────────────────────────────────────────────

/**
 * Build a MetafieldInput for a list.metaobject_reference field.
 *
 * Looks up display names → Metaobject GIDs in the bootstrap cache.
 * Attaches _displayValues (the matched names) for dashboard rendering.
 * Returns null when the cache is missing or no names match.
 *
 * @param {string}   attrKey      - e.g. "material"
 * @param {string[]} displayNames - human-readable value names
 * @returns {object|null}
 */
function listMf(attrKey, displayNames) {
  if (!displayNames || displayNames.length === 0) return null;

  const cache   = getMobjCache();
  const attrMap = cache.attributes?.[attrKey];

  if (!attrMap || Object.keys(attrMap).length === 0) return null;

  const matched = displayNames.filter(n => attrMap[n]);
  if (matched.length === 0) return null;

  return {
    namespace:      'shopify',
    key:            attrKey,
    type:           'list.metaobject_reference',
    value:          JSON.stringify(matched.map(n => attrMap[n])),
    _displayValues: matched,   // used by resolveCategoryMetafieldsForDisplay
  };
}

// ── Signal → display-name mapping rules ──────────────────────────────────────
// These functions translate classification signals into the exact display name
// strings stored in Shopify's standard metaobject definitions.
// Do NOT alter classification logic here — only the display-name list matters.

/** material */
function resolveMaterial({ styles = [] }) {
  const mats = ['Thermoplastic polyurethane (TPU)'];
  if (styles.includes('leather'))  mats.push('Faux leather');
  if (styles.includes('silicone')) mats.push('Silicone');
  return mats;
}

/** theme */
function resolveTheme({ ipBrands = [], aesthetics = [] }) {
  const themes = new Set();

  for (const ip of ipBrands) {
    if (['sanrio', 'san-x', 'disney', 'peanuts', 'bandai', 'sekiguchi'].includes(ip))
      themes.add('Cartoons');
    if (['anime', 'vocaloid'].includes(ip))
      themes.add('Anime');
    if (['game'].includes(ip))
      themes.add('Video games');
  }

  for (const a of aesthetics) {
    if (['y2k', 'coquette'].includes(a))
      themes.add('Retro/Vintage');
    if (['kawaii', 'pastel', 'jirai-kei'].includes(a))
      themes.add('Cartoons');
  }

  return [...themes];
}

/** attachment-options */
function resolveAttachmentOptions({ attachment }) {
  return attachment === 'magsafe' ? ['Magnet'] : [];
}

/**
 * connectivity-technology
 * Passive phone cases have no active connectivity components.
 * Reserved for future product types (e.g. battery cases, NFC wallets).
 */
function resolveConnectivityTechnology(_classification) {
  return [];
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Build Shopify category metafields for the 4 auto-settable attributes.
 *
 * Returns an empty array when the Metaobject GID cache has not been
 * bootstrapped yet (no values can be set until the one-time discovery
 * script is run).
 *
 * @param {object} classification - output of classifyProduct()
 * @returns {Array<MetafieldInput>}
 */
export function buildCategoryMetafields(classification) {
  const mfs  = [];
  const push = (mf) => { if (mf) mfs.push(mf); };

  push(listMf('material',                resolveMaterial(classification)));
  push(listMf('theme',                   resolveTheme(classification)));
  push(listMf('attachment-options',      resolveAttachmentOptions(classification)));
  push(listMf('connectivity-technology', resolveConnectivityTechnology(classification)));

  return mfs;
}

// ── Cache status helpers ──────────────────────────────────────────────────────

/**
 * Returns true when the Metaobject GID cache has been bootstrapped and
 * contains at least one attribute mapping.
 */
export function isTaxonomyCachePopulated() {
  return Object.keys(getMobjCache().attributes ?? {}).length > 0;
}

/**
 * Returns the ISO timestamp when the Metaobject GID cache was last built,
 * or null if the cache has not been created yet.
 */
export function taxonomyCacheFetchedAt() {
  return getMobjCache().discoveredAt ?? null;
}

// ── Display resolution ────────────────────────────────────────────────────────

/**
 * Convert a buildCategoryMetafields output array into human-readable display
 * objects for the dashboard Product Inspector.
 *
 * Supports the new list.metaobject_reference format (uses _displayValues when
 * present) and falls back gracefully to extracting the numeric tail of any GID.
 *
 * @param {Array<{namespace, key, type, value, _displayValues?}>} metafields
 * @returns {Array<{key, name, values}>}
 */
export function resolveCategoryMetafieldsForDisplay(metafields) {
  if (!Array.isArray(metafields)) return [];

  return metafields
    .filter(mf => mf.namespace === 'shopify')
    .map(mf => {
      const attrName = mf.key
        .replace(/-/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());

      let values;
      if (Array.isArray(mf._displayValues) && mf._displayValues.length > 0) {
        // Preferred path: display names stored alongside Metaobject GIDs.
        values = mf._displayValues;
      } else {
        // Fallback: decode GID array and use the last path segment as label.
        let gids;
        try { gids = JSON.parse(mf.value); } catch { gids = [mf.value]; }
        values = gids.map(g => String(g).split('/').pop()).filter(Boolean);
      }

      return { key: mf.key, name: attrName, values };
    })
    .filter(item => item.values.length > 0);
}
