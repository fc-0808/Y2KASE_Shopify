/**
 * Y2KASE Auto Title Generator
 *
 * Generates SEO-optimised Shopify titles from classifier output.
 * Target: 50–70 chars · Format: [Character] [Style] [Type] – [Feature]
 *
 * Rules (mirroring Google's product title best practices):
 *  - Character name first (highest search intent signal)
 *  - Style/construction second (differentiator)
 *  - Device + product type third
 *  - Key feature after em dash (optional, fills to 60 chars)
 *  - Never keyword-stuff; reads naturally
 */

// Character display names (canonical, human-readable)
const CHAR_NAMES = {
  'hello-kitty':       'Hello Kitty',
  'my-melody':         'My Melody',
  'cinnamoroll':       'Cinnamoroll',
  'kuromi':            'Kuromi',
  'pompompurin':       'Pompompurin',
  'pochacco':          'Pochacco',
  'keroppi':           'Keroppi',
  'tuxedo-sam':        'Tuxedo Sam',
  'little-twin-stars': 'Little Twin Stars',
  'badtz-maru':        'Badtz-Maru',
  'hangyodon':         'Hangyodon',
  'cogimyun':          'Cogimyun',
  'wish-me-mell':      'Wish Me Mell',
  'aggretsuko':        'Aggretsuko',
  'gudetama':          'Gudetama',
  'cinnamoangels':     'Cinnamoangels',
  'chiikawa':          'Chiikawa',
  'hatsune-miku':      'Hatsune Miku',
  'sailor-moon':       'Sailor Moon',
  'cardcaptor-sakura': 'Cardcaptor Sakura',
  'tokyo-mew-mew':     'Tokyo Mew Mew',
  'precure':           'Pretty Cure',
  'ghibli':            'Studio Ghibli',
  'jujutsu-kaisen':    'Jujutsu Kaisen',
  'demon-slayer':      'Demon Slayer',
  'blue-archive':      'Blue Archive',
  'pokemon':           'Pokemon',
  'winnie-the-pooh':   'Winnie the Pooh',
  'judy-hopps':        'Judy Hopps',
  'stitch':            'Stitch',
  'mickey-mouse':      'Mickey Mouse',
  'dumbo':             'Dumbo',
  'bambi':             'Bambi',
  'sleeping-beauty':   'Sleeping Beauty',
  'alice':             'Alice in Wonderland',
};

// Style display names (concise, descriptive)
const STYLE_LABELS = {
  'liquid-glitter': 'Liquid Glitter',
  'glitter':        'Glitter',
  'leather':        'Leather',
  'wallet':         'Wallet',
  'holographic':    'Holographic',
  'embroidery':     'Embroidery',
  'quilted':        'Quilted',
  'collage':        'Collage',
  'clear':          'Clear',
  'mirror':         'Mirror',
  'silicone':       'Silicone',
  '3d':             '3D',
  'floral':         'Floral',
  'beaded':         'Beaded',
};

// Feature display names (for the "–" suffix)
const FEATURE_LABELS = {
  'grip':        'with Grip',
  'charm':       'with Charm',
  'ring-stand':  'Ring Stand',
  'card-holder': 'Card Holder',
  'hand-strap':  'Hand Strap',
  'shaker':      'Shaker',
  'stand':       'Stand',
};

// Product type → device display name
const TYPE_LABELS = {
  'phone-case':   { iphone: 'iPhone Case', samsung: 'Samsung Case', universal: 'Phone Case' },
  'airpod-case':  { universal: 'AirPods Case' },
  'watch-strap':  { universal: 'Apple Watch Band' },
  'popsocket':    { universal: 'PopSocket' },
  'charm':        { universal: 'Phone Charm' },
};

/**
 * Generate a clean SEO title from classification data.
 * @param {object} classification  — output from classifyProduct()
 * @returns {string}               — title, max 70 chars
 */
export function generateTitle(classification) {
  const { characters, styles, features, productType, deviceBrand, attachment } = classification;

  // ── Character prefix ──────────────────────────────────────────────────
  // Use first 1-2 characters (e.g. "Hello Kitty & My Melody")
  const charParts = characters.slice(0, 2).map(c => CHAR_NAMES[c] || c);
  const charStr = charParts.length === 2
    ? `${charParts[0]} & ${charParts[1]}`
    : charParts[0] || 'Kawaii';

  // ── Style modifier ────────────────────────────────────────────────────
  // Use first detected style (most specific wins because liquid-glitter is before glitter)
  const styleStr = styles.length ? (STYLE_LABELS[styles[0]] || '') : '';

  // ── MagSafe indicator ─────────────────────────────────────────────────
  const magSafeStr = attachment === 'magsafe' ? 'MagSafe' : '';

  // ── Product type label ────────────────────────────────────────────────
  const typeLabels = TYPE_LABELS[productType] || { universal: 'Accessory' };
  const typeStr = typeLabels[deviceBrand] || typeLabels['universal'] || 'Case';

  // ── Build the main title part ─────────────────────────────────────────
  // Priority: Character [MagSafe] [Style] TypeLabel
  const mainParts = [charStr];
  if (magSafeStr && !styleStr) mainParts.push(magSafeStr);
  if (styleStr) mainParts.push(styleStr);
  mainParts.push(typeStr);

  let title = mainParts.join(' ');

  // ── Feature suffix (if space allows) ─────────────────────────────────
  // Add "– [Feature]" if total < 62 chars
  const priorityFeatures = ['card-holder', 'hand-strap', 'ring-stand', 'charm', 'grip', 'shaker'];
  const topFeature = priorityFeatures.find(f => features.includes(f));

  if (topFeature && title.length < 55) {
    const featureLabel = FEATURE_LABELS[topFeature];
    const candidate = `${title} – ${featureLabel}`;
    if (candidate.length <= 70) title = candidate;
  }

  // ── Aesthetic fallback suffix ─────────────────────────────────────────
  if (title.length < 45) {
    // Pad with "Kawaii" or aesthetic if very short
    title = `${title} – Kawaii`;
  }

  // ── Hard truncate at 70 ───────────────────────────────────────────────
  if (title.length > 70) {
    title = title.slice(0, 67) + '...';
  }

  return title;
}

/**
 * Check if a product title looks like it came from Etsy (keyword-stuffed).
 * Returns true if the title should be rewritten.
 */
export function needsTitleRewrite(title) {
  if (title.length > 80) return true;
  // Multiple iPhone model numbers crammed in = Etsy pattern
  if (/iphone \d+ \d+ \d+/i.test(title)) return true;
  // Comma-separated keyword lists
  if ((title.match(/,/g) || []).length >= 3) return true;
  return false;
}
