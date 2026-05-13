/**
 * Y2KASE — Category Metafield Builder
 *
 * Translates the classifier output (from classifier.mjs) into Shopify
 * "category metafields" — the 25 standardised taxonomy attribute metafields
 * that appear under "Category metafields" in the product admin for the
 * Mobile Phone Cases category (gid://shopify/TaxonomyCategory/el-4-8-4-2).
 *
 * Metafield wire format (Shopify Admin GraphQL API 2026-04):
 *   namespace : "shopify"
 *   key       : attribute slug  (e.g. "case-type")
 *   type      : "list.product_taxonomy_value_reference"
 *   value     : JSON-encoded array of TaxonomyValue GIDs
 *
 * Two-tier GID resolution (priority order):
 *   1. Live cache (taxonomy-attrs-cache.json) — populated by running:
 *        node scripts/lib/fetch-taxonomy-attrs.mjs
 *      Cache keys are display names  (e.g. "Back cover")
 *   2. Hardcoded fallback table below — same display-name keys, GIDs sourced
 *      from the live cache that was already run on 2026-05-13.
 *      Fallbacks cover every attribute we auto-populate so the pipeline works
 *      even before the cache file exists.
 *
 * Attributes auto-populated for every Y2KASE product:
 *   case-type                  — Back cover / Wallet with card slots / Stand
 *   case-transparency-level    — Opaque / Clear / Patterned Transparent …
 *   bag-case-material          — TPU (+ Faux leather / Acrylic for specials)
 *   material                   — TPU (generic "Material" attribute)
 *   finish                     — Matte / Gloss / Metallic
 *   attachment-options         — Magnet  (MagSafe products)
 *   magsafe-compatibility      — MagSafe compatible / Not MagSafe compatible
 *   mobile-phone-case-features — Anti-fingerprint, Ring grip, Shockproof, Snug fit
 *   screen-protection-features — Raised edges
 *   integrated-stand-type      — Ring stand  (products with ring-stand feature)
 *   wallet-features            — Card organization  (wallet products)
 *   theme                      — Anime / Cartoons / Pop culture / Retro/Vintage
 */

import { existsSync, readFileSync } from 'fs';
import { resolve, dirname }         from 'path';
import { fileURLToPath }            from 'url';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = resolve(__dirname, '../../.cache/taxonomy-attrs-cache.json');

// ── Hardcoded fallback GIDs ───────────────────────────────────────────────────
// Sourced from live Shopify API query run on 2026-05-13 via fetch-taxonomy-attrs.mjs.
// Keys are exact display names returned by the API.
const FALLBACK = {
  'case-type': {
    'Armband':                      'gid://shopify/TaxonomyValue/7772',
    'Back cover':                   'gid://shopify/TaxonomyValue/11551',
    'Belt clip':                    'gid://shopify/TaxonomyValue/11552',
    'Book style':                   'gid://shopify/TaxonomyValue/11553',
    'Bumper':                       'gid://shopify/TaxonomyValue/11554',
    'Bumper with built-in screen protector': 'gid://shopify/TaxonomyValue/11555',
    'Decal':                        'gid://shopify/TaxonomyValue/11556',
    'Flip':                         'gid://shopify/TaxonomyValue/11557',
    'Folio':                        'gid://shopify/TaxonomyValue/11558',
    'Holder':                       'gid://shopify/TaxonomyValue/11559',
    'Holster':                      'gid://shopify/TaxonomyValue/11560',
    'Keyboard case':                'gid://shopify/TaxonomyValue/11561',
    'Shell cover':                  'gid://shopify/TaxonomyValue/11562',
    'Skin':                         'gid://shopify/TaxonomyValue/11563',
    'Wallet':                       'gid://shopify/TaxonomyValue/11564',
    'Wallet with card slots':       'gid://shopify/TaxonomyValue/11565',
    'Finger grip':                  'gid://shopify/TaxonomyValue/12304',
    'Interchangeable loop':         'gid://shopify/TaxonomyValue/12305',
    'Lanyard':                      'gid://shopify/TaxonomyValue/18657',
    'Stand':                        'gid://shopify/TaxonomyValue/18658',
    'Other':                        'gid://shopify/TaxonomyValue/18659',
  },
  'case-transparency-level': {
    'Clear':                'gid://shopify/TaxonomyValue/28230',
    'Frosted':              'gid://shopify/TaxonomyValue/28231',
    'Gloss Clear':          'gid://shopify/TaxonomyValue/28232',
    'Opaque':               'gid://shopify/TaxonomyValue/28233',
    'Patterned Transparent':'gid://shopify/TaxonomyValue/28234',
    'Semi-Clear':           'gid://shopify/TaxonomyValue/28235',
    'Smoke':                'gid://shopify/TaxonomyValue/28236',
    'Tinted':               'gid://shopify/TaxonomyValue/28237',
    'Translucent':          'gid://shopify/TaxonomyValue/28238',
    'Other':                'gid://shopify/TaxonomyValue/28239',
  },
  'bag-case-material': {
    'Acrylic':                            'gid://shopify/TaxonomyValue/21914',
    'Alcantara':                          'gid://shopify/TaxonomyValue/21915',
    'Aluminum':                           'gid://shopify/TaxonomyValue/21916',
    'Canvas':                             'gid://shopify/TaxonomyValue/21918',
    'Faux leather':                       'gid://shopify/TaxonomyValue/21924',
    'Leather':                            'gid://shopify/TaxonomyValue/21927',
    'Leatherette':                        'gid://shopify/TaxonomyValue/21928',
    'Metal':                              'gid://shopify/TaxonomyValue/21932',
    'Plastic':                            'gid://shopify/TaxonomyValue/21936',
    'Polyester':                          'gid://shopify/TaxonomyValue/21937',
    'Thermoplastic polyurethane (TPU)':   'gid://shopify/TaxonomyValue/21940',
    'Velvet':                             'gid://shopify/TaxonomyValue/21942',
    'Other':                              'gid://shopify/TaxonomyValue/21945',
  },
  'material': {
    'Thermoplastic polyurethane (TPU)': 'gid://shopify/TaxonomyValue/592',
    'Faux leather':                     'gid://shopify/TaxonomyValue/52',
    'Acrylic':                          'gid://shopify/TaxonomyValue/67',
    'Leather':                          'gid://shopify/TaxonomyValue/558',
    'Silicone':                         'gid://shopify/TaxonomyValue/809',
    'Plastic':                          'gid://shopify/TaxonomyValue/626',
    'Other':                            'gid://shopify/TaxonomyValue/372',
  },
  'finish': {
    'Gloss':    'gid://shopify/TaxonomyValue/17355',
    'Matte':    'gid://shopify/TaxonomyValue/17356',
    'Satin':    'gid://shopify/TaxonomyValue/17357',
    'Metallic': 'gid://shopify/TaxonomyValue/17378',
    'Other':    'gid://shopify/TaxonomyValue/27077',
  },
  'attachment-options': {
    'Clip':    'gid://shopify/TaxonomyValue/3132',
    'Magnet':  'gid://shopify/TaxonomyValue/6348',
    'Lanyard': 'gid://shopify/TaxonomyValue/6877',
    'Pin':     'gid://shopify/TaxonomyValue/6878',
    'Other':   'gid://shopify/TaxonomyValue/26426',
  },
  'attachment-method': {
    'Hanging':    'gid://shopify/TaxonomyValue/7732',
    'Clamping':   'gid://shopify/TaxonomyValue/11291',
    'Standalone': 'gid://shopify/TaxonomyValue/11300',
    'Velcro':     'gid://shopify/TaxonomyValue/18129',
    'Clip-on':    'gid://shopify/TaxonomyValue/18138',
    'Other':      'gid://shopify/TaxonomyValue/26826',
  },
  'magsafe-compatibility': {
    'MagSafe compatible':       'gid://shopify/TaxonomyValue/28358',
    'Not MagSafe compatible':   'gid://shopify/TaxonomyValue/28359',
    'Requires adhesive ring':   'gid://shopify/TaxonomyValue/28360',
    'Other':                    'gid://shopify/TaxonomyValue/28361',
  },
  'mobile-phone-case-features': {
    'AI-powered':       'gid://shopify/TaxonomyValue/23343',
    'Anti-fingerprint': 'gid://shopify/TaxonomyValue/23344',
    'Finger loop':      'gid://shopify/TaxonomyValue/23345',
    'Modular':          'gid://shopify/TaxonomyValue/23346',
    'Pocket friendly':  'gid://shopify/TaxonomyValue/23347',
    'Ring grip':        'gid://shopify/TaxonomyValue/23348',
    'Shockproof':       'gid://shopify/TaxonomyValue/23349',
    'Snug fit':         'gid://shopify/TaxonomyValue/23350',
    'Other':            'gid://shopify/TaxonomyValue/27797',
  },
  'screen-protection-features': {
    'Built-in screen protector': 'gid://shopify/TaxonomyValue/32861',
    'Flip cover':                'gid://shopify/TaxonomyValue/32862',
    'None':                      'gid://shopify/TaxonomyValue/32863',
    'Raised edges':              'gid://shopify/TaxonomyValue/32864',
    'Tempered glass included':   'gid://shopify/TaxonomyValue/32865',
    'Other':                     'gid://shopify/TaxonomyValue/32866',
  },
  'integrated-stand-type': {
    '360° rotatable stand':        'gid://shopify/TaxonomyValue/28323',
    'Adjustable multi-angle stand':'gid://shopify/TaxonomyValue/28324',
    'Fold-out kickstand':          'gid://shopify/TaxonomyValue/28325',
    'Grip stand':                  'gid://shopify/TaxonomyValue/28326',
    'Lanyard stand':               'gid://shopify/TaxonomyValue/28327',
    'Magnetic stand':              'gid://shopify/TaxonomyValue/28328',
    'Ring stand':                  'gid://shopify/TaxonomyValue/28329',
    'Wallet fold stand':           'gid://shopify/TaxonomyValue/28330',
    'Other':                       'gid://shopify/TaxonomyValue/28331',
  },
  'wallet-features': {
    'Card organization': 'gid://shopify/TaxonomyValue/22857',
    'Compact design':    'gid://shopify/TaxonomyValue/22858',
    'RFID protection':   'gid://shopify/TaxonomyValue/22859',
    'Vegan friendly':    'gid://shopify/TaxonomyValue/22860',
    'Waterproof':        'gid://shopify/TaxonomyValue/22861',
    'Other':             'gid://shopify/TaxonomyValue/27754',
  },
  'theme': {
    'Anime':          'gid://shopify/TaxonomyValue/11419',
    'Cartoons':       'gid://shopify/TaxonomyValue/7897',
    'Comics':         'gid://shopify/TaxonomyValue/7899',
    'Fantasy':        'gid://shopify/TaxonomyValue/17406',
    'Fashion':        'gid://shopify/TaxonomyValue/7902',
    'Floral':         'gid://shopify/TaxonomyValue/17407',
    'Movies & TV':    'gid://shopify/TaxonomyValue/14642',
    'Pop culture':    'gid://shopify/TaxonomyValue/15125',
    'Retro/Vintage':  'gid://shopify/TaxonomyValue/22056',
    'Video games':    'gid://shopify/TaxonomyValue/7913',
    'Other':          'gid://shopify/TaxonomyValue/17413',
  },
};

// ── Load live cache ───────────────────────────────────────────────────────────
let _cache = null;

function getCache() {
  if (_cache !== null) return _cache;
  if (existsSync(CACHE_PATH)) {
    try { _cache = JSON.parse(readFileSync(CACHE_PATH, 'utf-8')); }
    catch { _cache = { attributes: {} }; }
  } else {
    _cache = { attributes: {} };
  }
  return _cache;
}

// ── Value GID resolver ────────────────────────────────────────────────────────

/**
 * Resolve a taxonomy value GID by display name.
 * Priority: live cache → hardcoded fallback.
 *
 * @param {string} attrSlug   - kebab attribute slug  e.g. "case-type"
 * @param {string} valueName  - exact display name     e.g. "Back cover"
 * @returns {string|null}
 */
function gid(attrSlug, valueName) {
  const cache = getCache();
  const liveAttr = cache.attributes?.[attrSlug];
  if (liveAttr?.values?.[valueName]) return liveAttr.values[valueName];
  return FALLBACK[attrSlug]?.[valueName] ?? null;
}

/**
 * Build a MetafieldInput for a list.product_taxonomy_value_reference field.
 */
function listMf(attrSlug, valueNames) {
  const gids = valueNames.map(n => gid(attrSlug, n)).filter(Boolean);
  if (gids.length === 0) return null;
  return {
    namespace: 'shopify',
    key:       attrSlug,
    type:      'list.product_taxonomy_value_reference',
    value:     JSON.stringify(gids),
  };
}

/**
 * Build a MetafieldInput for a product_taxonomy_value_reference field (single).
 */
function singleMf(attrSlug, valueName) {
  const g = gid(attrSlug, valueName);
  if (!g) return null;
  return {
    namespace: 'shopify',
    key:       attrSlug,
    type:      'list.product_taxonomy_value_reference',
    value:     JSON.stringify([g]),
  };
}

// ── Signal → taxonomy-value mapping rules ────────────────────────────────────

/** case-type */
function resolveCaseType({ styles = [], features = [] }) {
  if (styles.includes('wallet') || features.includes('card-holder')) {
    return ['Wallet with card slots'];
  }
  if (features.includes('ring-stand') || features.includes('stand')) {
    return ['Back cover', 'Stand'];
  }
  return ['Back cover'];
}

/** case-transparency-level */
function resolveTransparency({ styles = [] }) {
  if (styles.includes('liquid-glitter') || styles.includes('glitter') ||
      styles.includes('holographic')) {
    return 'Patterned Transparent';
  }
  if (styles.includes('clear'))  return 'Clear';
  if (styles.includes('mirror')) return 'Tinted';
  return 'Opaque';
}

/** bag-case-material — the specific case material attribute */
function resolveBagCaseMaterial({ styles = [] }) {
  const mats = ['Thermoplastic polyurethane (TPU)'];
  if (styles.includes('leather'))                                mats.push('Faux leather');
  if (styles.includes('glitter') || styles.includes('liquid-glitter')) mats.push('Acrylic');
  return mats;
}

/** material — the generic material attribute (separate from bag-case-material) */
function resolveMaterial({ styles = [] }) {
  const mats = ['Thermoplastic polyurethane (TPU)'];
  if (styles.includes('leather'))   mats.push('Faux leather');
  if (styles.includes('silicone'))  mats.push('Silicone');
  return mats;
}

/** finish */
function resolveFinish({ styles = [] }) {
  if (styles.includes('glitter') || styles.includes('holographic') ||
      styles.includes('mirror'))  return ['Metallic'];
  if (styles.includes('leather') || styles.includes('quilted')) return ['Matte'];
  if (styles.includes('clear'))   return ['Gloss'];
  // Default polycarbonate + TPU hybrid: matte back
  return ['Matte'];
}

/** attachment-options */
function resolveAttachmentOptions({ attachment }) {
  if (attachment === 'magsafe') return ['Magnet'];
  return [];
}

/** magsafe-compatibility */
function resolveMagSafeCompatibility({ attachment }) {
  return attachment === 'magsafe' ? 'MagSafe compatible' : 'Not MagSafe compatible';
}

/**
 * mobile-phone-case-features
 *
 * Baseline features that every Y2KASE case provides:
 *   - Anti-fingerprint coating on hard shell back
 *   - Snug fit (precision moulded)
 *   - Shockproof (TPU bumper)
 * Additional features inferred from classification.
 */
function resolveCaseFeatures({ styles = [], features = [], attachment }) {
  const wanted = ['Anti-fingerprint', 'Snug fit', 'Shockproof'];
  if (features.includes('ring-stand'))                     wanted.push('Ring grip');
  if (features.includes('card-holder') || styles.includes('wallet')) {
    /* Card slot/pocket friendly — covered by wallet-features */
    wanted.push('Pocket friendly');
  }
  if (features.includes('shaker') || styles.includes('liquid-glitter')) {
    // already Shockproof in baseline
  }
  return wanted;
}

/** screen-protection-features */
function resolveScreenProtection() {
  // All Y2KASE cases have raised edges (raised bezel) — stated in product desc
  return ['Raised edges'];
}

/** integrated-stand-type */
function resolveStandType({ features = [] }) {
  if (features.includes('ring-stand')) return 'Ring stand';
  return null;
}

/** wallet-features */
function resolveWalletFeatures({ styles = [], features = [] }) {
  if (!styles.includes('wallet') && !features.includes('card-holder')) return null;
  return ['Card organization'];
}

/**
 * theme
 *
 * Maps our IP/aesthetic classification to the closest Shopify theme taxonomy value.
 * Sanrio / anime IPs → "Cartoons" or "Anime"; Disney IPs → "Cartoons"; etc.
 */
function resolveTheme({ ipBrands = [], aesthetics = [], characters = [] }) {
  const themes = new Set();

  // IP brand → theme mapping
  for (const ip of ipBrands) {
    if (['sanrio', 'san-x'].includes(ip))             themes.add('Cartoons');
    if (['anime', 'vocaloid'].includes(ip))           themes.add('Anime');
    if (['disney'].includes(ip))                      themes.add('Cartoons');
    if (['game'].includes(ip))                        themes.add('Video games');
    if (['peanuts', 'bandai', 'sekiguchi'].includes(ip)) themes.add('Cartoons');
  }

  // Aesthetic → theme mapping
  for (const a of aesthetics) {
    if (['y2k', 'coquette'].includes(a))              themes.add('Retro/Vintage');
    if (['kawaii', 'pastel', 'jirai-kei'].includes(a))themes.add('Cartoons');
  }

  if (themes.size === 0) return null;
  return [...themes];
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Build all resolvable category metafields for a Mobile Phone Case product.
 *
 * @param {object} classification - output of classifyProduct()
 * @returns {Array<MetafieldInput>}
 */
export function buildCategoryMetafields(classification) {
  const mfs = [];
  const push = (mf) => { if (mf) mfs.push(mf); };

  // case-type
  push(listMf('case-type', resolveCaseType(classification)));

  // case-transparency-level
  push(singleMf('case-transparency-level', resolveTransparency(classification)));

  // bag-case-material
  push(listMf('bag-case-material', resolveBagCaseMaterial(classification)));

  // material (generic)
  push(listMf('material', resolveMaterial(classification)));

  // finish
  push(listMf('finish', resolveFinish(classification)));

  // attachment-options
  const attachOpts = resolveAttachmentOptions(classification);
  if (attachOpts.length > 0) push(listMf('attachment-options', attachOpts));

  // magsafe-compatibility
  push(singleMf('magsafe-compatibility', resolveMagSafeCompatibility(classification)));

  // mobile-phone-case-features
  push(listMf('mobile-phone-case-features', resolveCaseFeatures(classification)));

  // screen-protection-features
  push(listMf('screen-protection-features', resolveScreenProtection()));

  // integrated-stand-type
  const standType = resolveStandType(classification);
  if (standType) push(singleMf('integrated-stand-type', standType));

  // wallet-features
  const walletFeats = resolveWalletFeatures(classification);
  if (walletFeats) push(listMf('wallet-features', walletFeats));

  // theme
  const themes = resolveTheme(classification);
  if (themes) push(listMf('theme', themes));

  return mfs;
}

/**
 * Returns true if the live taxonomy cache has been populated.
 */
export function isTaxonomyCachePopulated() {
  return Object.keys(getCache().attributes ?? {}).length > 0;
}

/**
 * Returns the ISO timestamp when the cache was last fetched, or null.
 */
export function taxonomyCacheFetchedAt() {
  return getCache().fetchedAt ?? null;
}

// ── Display resolution ────────────────────────────────────────────────────────

/**
 * Convert a raw metafields array (as built by buildCategoryMetafields) into
 * human-readable display objects for the dashboard Product Inspector.
 *
 * Each entry in the input array must have { namespace, key, type, value }
 * where value is a JSON-encoded array of TaxonomyValue GIDs.
 *
 * Returns an array of { key, name, values: string[] } — one entry per
 * metafield that has a non-empty value list.  GIDs are resolved to display
 * names using the live cache first, then the hardcoded FALLBACK table.
 *
 * @param {Array<{namespace:string, key:string, type:string, value:string}>} metafields
 * @returns {Array<{key:string, name:string, values:string[]}>}
 */
export function resolveCategoryMetafieldsForDisplay(metafields) {
  if (!Array.isArray(metafields)) return [];
  const cache = getCache();

  return metafields
    .filter(mf => mf.namespace === 'shopify')
    .map(mf => {
      // Attribute display name — prefer live cache, fall back to title-casing the key
      const attrData = cache.attributes?.[mf.key];
      const attrName = attrData?.name
        ?? mf.key.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

      // Build reverse map: GID → display name
      const revMap = {};

      // 1. Live cache values
      if (attrData?.values) {
        for (const [name, g] of Object.entries(attrData.values)) {
          revMap[g] = name;
        }
      }

      // 2. Hardcoded fallback values (fills gaps if cache is stale/missing)
      const fbAttr = FALLBACK[mf.key];
      if (fbAttr) {
        for (const [name, g] of Object.entries(fbAttr)) {
          if (!revMap[g]) revMap[g] = name;
        }
      }

      // Decode GID array and resolve to names
      let gids;
      try { gids = JSON.parse(mf.value); } catch { gids = [mf.value]; }

      const values = gids
        .map(g => revMap[g] ?? g.split('/').pop())  // fallback: last GID segment
        .filter(Boolean);

      return { key: mf.key, name: attrName, values };
    })
    .filter(item => item.values.length > 0);
}
