/**
 * Y2KASE Title Generator — v2
 *
 * Generates SEO-optimised, unique Shopify product titles from classifier output
 * and the original Etsy listing title.
 *
 * Optimised for:
 *   Google Shopping  — character + product type in the first 55 chars, no stuffing
 *   AI-powered search — (ChatGPT, Gemini, Perplexity) natural descriptive language
 *   Shopify storefront — faceted search, collection pages, predictive search
 *
 * Format: [Character] [Theme] [MagSafe] [Product Type] – [Feature]
 * Target: 50–70 characters · hard cap at 70.
 *
 * The Theme slot is the key differentiator.  It is extracted from the raw Etsy
 * title (passed as the second argument) so each listing gets a unique keyword
 * derived from its actual design: Strawberry, Leopard, Gingham, Winter,
 * Angel, Pearl, Pastel Purple … rather than a generic "Clear" or "Kawaii".
 */

// ── Character display names ───────────────────────────────────────────────────
// Canonical, human-readable forms that read naturally in a product title.
const CHAR_NAMES = {
  'hello-kitty':        'Hello Kitty',
  'my-melody':          'My Melody',
  'cinnamoroll':        'Cinnamoroll',
  'kuromi':             'Kuromi',
  'pompompurin':        'Pompompurin',
  'pochacco':           'Pochacco',
  'keroppi':            'Keroppi',
  'tuxedo-sam':         'Tuxedo Sam',
  'little-twin-stars':  'Little Twin Stars',
  'badtz-maru':         'Badtz-Maru',
  'hangyodon':          'Hangyodon',
  'cogimyun':           'Cogimyun',
  'wish-me-mell':       'Wish Me Mell',
  'aggretsuko':         'Aggretsuko',
  'gudetama':           'Gudetama',
  'cinnamoangels':      'Cinnamoangels',
  'chiikawa':           'Chiikawa',
  'hatsune-miku':       'Hatsune Miku',
  'sailor-moon':        'Sailor Moon',
  'cardcaptor-sakura':  'Cardcaptor Sakura',
  'tokyo-mew-mew':      'Tokyo Mew Mew',
  'precure':            'Pretty Cure',
  'ghibli':             'Studio Ghibli',
  'jujutsu-kaisen':     'Jujutsu Kaisen',
  'demon-slayer':       'Demon Slayer',
  'blue-archive':       'Blue Archive',
  'pokemon':            'Pokemon',
  'winnie-the-pooh':    'Winnie the Pooh',
  'judy-hopps':         'Judy Hopps',
  'stitch':             'Stitch',
  'mickey-mouse':       'Mickey Mouse',
  'dumbo':              'Dumbo',
  'bambi':              'Bambi',
  'sleeping-beauty':    'Sleeping Beauty',
  'alice':              'Alice in Wonderland',
  'snoopy':             'Snoopy',
  'tamagotchi':         'Tamagotchi',
  'monchhichi':         'Monchhichi',
  'rilakkuma':          'Rilakkuma',
  'sumikko':            'Sumikko Gurashi',
  'charmmy-kitty':      'Charmmy Kitty',
  'sleepy-star':        'Sleepy Star',
  'maneki-neko':        'Maneki Neko',
};

// ── Product type → device label ───────────────────────────────────────────────
const TYPE_LABELS = {
  'phone-case':  { iphone: 'iPhone Case', samsung: 'Samsung Case', universal: 'Phone Case' },
  'airpod-case': { universal: 'AirPods Case' },
  'watch-strap': { universal: 'Apple Watch Band' },
  'popsocket':   { universal: 'PopSocket' },
  'charm':       { universal: 'Phone Charm' },
};

// ── Theme extraction patterns ─────────────────────────────────────────────────
// Ordered from most specific to least specific so the first match wins.
// Applied against the raw Etsy title for maximum signal richness.
//
// SEO rationale: theme keywords narrow buyer intent and appear naturally in
// conversational AI queries ("show me a strawberry Hello Kitty iPhone case").
// They also serve as the primary disambiguation token when multiple products
// share the same character + feature profile.
const THEME_PATTERNS = [
  // ── Named motifs & design themes (highest priority) ──────────────────────
  [/lunar new year/i,              'Lunar New Year'],
  [/night sky/i,                   'Night Sky'],
  [/coffee house/i,                'Coffee House'],
  [/\bleopard\b/i,                 'Leopard'],
  [/\bgingham\b/i,                 'Gingham'],
  [/\bplaid\b/i,                   'Plaid'],
  [/\bstrawberry\b/i,              'Strawberry'],
  [/cherry blossom|sakura/i,       'Cherry Blossom'],
  [/\bcherry\b/i,                  'Cherry'],
  // "apple" guard: skip "Apple Watch" or brand references
  [/\bapple\b(?! watch)(?! inc)/i, 'Apple'],
  [/floral|flower case|flower grip/i, 'Floral'],
  [/\bbutterfly\b/i,               'Butterfly'],
  [/\bunicorn\b/i,                 'Unicorn'],
  [/\bangel\b/i,                   'Angel'],
  [/\bheart\b/i,                   'Heart'],
  // "star" guard: skip "Star Wars"
  [/\bstar\b(?! wars)/i,           'Star'],
  [/\bbow\b/i,                     'Bow'],
  [/\bpearl\b/i,                   'Pearl'],
  [/shaggy|plush fur|\bfur\b/i,    'Plush'],
  // ── Seasons & occasions ──────────────────────────────────────────────────
  [/autumn leaf|autumn/i,          'Autumn'],
  [/\bwinter\b/i,                  'Winter'],
  [/\bspring\b/i,                  'Spring'],
  [/\bsummer\b/i,                  'Summer'],
  // ── Visual material / finish styles (more distinct than colour) ──────────
  [/liquid glitter/i,              'Liquid Glitter'],
  [/\bglitter\b/i,                 'Glitter'],
  [/\biridescent\b/i,              'Iridescent'],
  [/\bholographic\b/i,             'Holographic'],
  // ── Aesthetic / cultural modifiers (before generic colours) ─────────────
  // Placed here so "Y2K Charm" in a title yields "Y2K" when no stronger theme
  // is present, distinguishing e.g. a Y2K-charm HK case from a plain-charm one.
  [/\by2k\b/i,                     'Y2K'],
  [/\bretro\b/i,                   'Retro'],
  [/\bgoth\b/i,                    'Goth'],
  [/\bcoquette\b/i,                'Coquette'],
  // ── Colours (lowest priority — only when no design motif found) ──────────
  [/pastel purple/i,               'Pastel Purple'],
  [/pastel pink/i,                 'Pastel Pink'],
  [/pastel blue/i,                 'Pastel Blue'],
  [/\bpastel\b/i,                  'Pastel'],
  [/\borange\b/i,                  'Orange'],
  [/\bpurple\b/i,                  'Purple'],
  [/\bblue\b/i,                    'Blue'],
  [/\bred\b(?! bead)/i,            'Red'],
  [/\bpink\b/i,                    'Pink'],
  [/\bgreen\b/i,                   'Green'],
  [/\bgold\b/i,                    'Gold'],
];

/**
 * Extract the most specific theme keyword from a raw Etsy listing title.
 *
 * Returns null if no recognisable theme is found — the caller should omit
 * the theme slot rather than inventing one.
 *
 * @param {string} etsyTitle  raw, un-cleaned Etsy listing title
 * @returns {string|null}
 */
function extractTheme(etsyTitle) {
  if (!etsyTitle) return null;
  for (const [pattern, label] of THEME_PATTERNS) {
    if (pattern.test(etsyTitle)) return label;
  }
  return null;
}

// ── Feature suffix rules ──────────────────────────────────────────────────────
// Rules are checked in order; the first match wins.
// Combos (grip + charm) are listed before singles so they have higher priority.
const FEATURE_SUFFIX_RULES = [
  { needs: ['grip', 'charm'], label: 'with Grip & Charm' },
  { needs: ['hand-strap'],    label: 'with Strap'        },
  { needs: ['card-holder'],   label: 'with Card Holder'  },
  { needs: ['ring-stand'],    label: 'Ring Stand'        },
  { needs: ['grip'],          label: 'with Grip'         },
  { needs: ['charm'],         label: 'with Charm'        },
];

/**
 * Derive the best feature suffix string ("with Grip & Charm", "with Charm", …).
 * Returns an empty string when no relevant feature is detected.
 *
 * @param {string[]} features  from classifyProduct()
 * @returns {string}
 */
function pickFeatureSuffix(features) {
  for (const rule of FEATURE_SUFFIX_RULES) {
    if (rule.needs.every(f => features.includes(f))) return rule.label;
  }
  return '';
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a clean, SEO-optimised Shopify product title.
 *
 * Assembly order:
 *   [Character] [Theme] [MagSafe] [Product Type][ – Feature]
 *
 * The Theme slot bridges the gap between classifier output and listing-level
 * uniqueness: it is extracted from the raw Etsy title so each product's most
 * distinctive design word (Strawberry, Leopard, Angel, Winter …) surfaces
 * in the Shopify title, preventing handle collisions and improving search
 * relevance for both keyword and semantic/AI-powered queries.
 *
 * @param {object} classification  output from classifyProduct()
 * @param {string} [etsyTitle]     raw Etsy listing title (for theme extraction)
 * @returns {string}               ≤70 characters
 */
export function generateTitle(classification, etsyTitle = '') {
  const { characters, features, productType, deviceBrand, attachment } = classification;

  // ── 1. Character string ──────────────────────────────────────────────────
  // Use up to two characters joined with "&"; fall back to "Kawaii" for
  // non-IP originals (e.g. fruit-themed or abstract designs).
  const charParts = characters.slice(0, 2).map(c => CHAR_NAMES[c] || c);
  const charStr = charParts.length === 2
    ? `${charParts[0]} & ${charParts[1]}`
    : charParts[0] || 'Kawaii';

  // ── 2. Theme from Etsy title ─────────────────────────────────────────────
  const theme = extractTheme(etsyTitle);

  // ── 3. Attachment modifier ───────────────────────────────────────────────
  const magSafeStr = attachment === 'magsafe' ? 'MagSafe' : '';

  // ── 4. Product type label ────────────────────────────────────────────────
  const typeLabels = TYPE_LABELS[productType] ?? { universal: 'Accessory' };
  const typeStr = typeLabels[deviceBrand] ?? typeLabels['universal'] ?? 'Case';

  // ── 5. Feature suffix ────────────────────────────────────────────────────
  const featureSuffix = pickFeatureSuffix(features);

  // ── 6. Assemble ──────────────────────────────────────────────────────────
  const mainParts = [charStr];
  if (theme)      mainParts.push(theme);
  if (magSafeStr) mainParts.push(magSafeStr);
  mainParts.push(typeStr);

  let title = mainParts.join(' ');
  if (featureSuffix) title = `${title} – ${featureSuffix}`;

  // Hard cap at 70 characters (Google Shopping truncates at ~70)
  if (title.length > 70) title = title.slice(0, 67) + '...';

  return title;
}

/**
 * Detect whether a title looks like a keyword-stuffed Etsy listing.
 * When true, buildShopifyPayload() replaces the title with generateTitle().
 *
 * Signals:
 *  - Longer than 80 chars                    (all Etsy titles qualify)
 *  - Multiple consecutive iPhone model numbers ("iPhone 17 16 15 14")
 *  - Three or more comma-separated clauses    (Etsy keyword-list pattern)
 */
export function needsTitleRewrite(title) {
  if (title.length > 80) return true;
  if (/iphone \d+ \d+ \d+/i.test(title)) return true;
  if ((title.match(/,/g) ?? []).length >= 3) return true;
  return false;
}
