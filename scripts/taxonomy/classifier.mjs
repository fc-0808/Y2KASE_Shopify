/**
 * Y2KASE Enterprise Taxonomy Classifier
 *
 * Determines the full taxonomy for any product based on its title + existing tags.
 * Pure function — no side effects. Used by normalise-tags.mjs and future scripts.
 *
 * TAXONOMY DIMENSIONS:
 *  type:       what the product IS    (phone-case, airpod-case, watch-strap, popsocket, charm)
 *  device:     what it fits           (iphone, samsung, universal)
 *  attach:     how it attaches        (magsafe, adhesive, standard)
 *  char:       character design       (hello-kitty, my-melody, cinnamoroll, kuromi, …)
 *  ip:         IP/franchise owner     (sanrio, disney, anime, vocaloid)
 *  style:      construction style     (leather, wallet, glitter, liquid-glitter, holographic, …)
 *  aesthetic:  visual aesthetic       (kawaii, coquette, y2k, jirai-kei, pastel)
 *  feature:    physical features      (grip, charm, ring-stand, card-holder, hand-strap, shaker)
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

const has = (text, ...patterns) =>
  patterns.some(p => typeof p === 'string'
    ? text.toLowerCase().includes(p.toLowerCase())
    : p.test(text));

const tagSet = (tags = '') =>
  new Set(tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean));

// ── Character detection ───────────────────────────────────────────────────────

const CHARACTER_RULES = [
  // ── Sanrio ─────────────────────────────────────────────────────────────
  { id: 'hello-kitty',     ip: 'sanrio',   detect: (t) => has(t, 'hello kitty', 'hello-kitty') },
  { id: 'my-melody',       ip: 'sanrio',   detect: (t) => has(t, 'my melody', 'my sweet piano', 'pink melody', 'pink piano sheep', 'sweet piano') },
  { id: 'cinnamoroll',     ip: 'sanrio',   detect: (t) => has(t, 'cinnamoroll') },
  { id: 'kuromi',          ip: 'sanrio',   detect: (t) => has(t, 'kuromi') },
  { id: 'pompompurin',     ip: 'sanrio',   detect: (t) => has(t, 'pompompurin', 'purin') },
  { id: 'pochacco',        ip: 'sanrio',   detect: (t) => has(t, 'pochacco') },
  { id: 'keroppi',         ip: 'sanrio',   detect: (t) => has(t, 'keroppi') },
  { id: 'tuxedo-sam',      ip: 'sanrio',   detect: (t) => has(t, 'tuxedo sam', 'tuxedosam') },
  { id: 'little-twin-stars', ip: 'sanrio', detect: (t) => has(t, 'little twin stars', 'kiki and lala', 'kiki lala') },
  { id: 'badtz-maru',      ip: 'sanrio',   detect: (t) => has(t, 'badtz', 'badtz-maru', 'badtzmaru') },
  { id: 'hangyodon',       ip: 'sanrio',   detect: (t) => has(t, 'hangyodon') },
  { id: 'cogimyun',        ip: 'sanrio',   detect: (t) => has(t, 'cogimyun') },
  { id: 'wish-me-mell',    ip: 'sanrio',   detect: (t) => has(t, 'wish me mell', 'wishmemell') },
  { id: 'aggretsuko',      ip: 'sanrio',   detect: (t) => has(t, 'aggretsuko', 'retsuko') },
  { id: 'gudetama',        ip: 'sanrio',   detect: (t) => has(t, 'gudetama') },
  { id: 'cinnamoangels',   ip: 'sanrio',   detect: (t) => has(t, 'cinnamoangels', 'cinnamon angel') },
  // ── Anime / Indie IP ───────────────────────────────────────────────────
  { id: 'chiikawa',        ip: 'anime',    detect: (t) => has(t, 'chiikawa') },
  { id: 'hatsune-miku',    ip: 'vocaloid', detect: (t) => has(t, 'hatsune miku', 'miku', 'vocaloid') },
  { id: 'sailor-moon',     ip: 'anime',    detect: (t) => has(t, 'sailor moon', 'usagi', 'luna cat') },
  { id: 'cardcaptor-sakura', ip: 'anime',  detect: (t) => has(t, 'cardcaptor', 'card captor', 'sakura') },
  { id: 'tokyo-mew-mew',   ip: 'anime',    detect: (t) => has(t, 'tokyo mew mew', 'mew mew') },
  { id: 'precure',         ip: 'anime',    detect: (t) => has(t, 'precure', 'pretty cure') },
  { id: 'ghibli',          ip: 'anime',    detect: (t) => has(t, 'ghibli', 'totoro', 'spirited away', 'no face', 'howl') },
  { id: 'jujutsu-kaisen',  ip: 'anime',    detect: (t) => has(t, 'jujutsu kaisen', 'gojo', 'sukuna') },
  { id: 'demon-slayer',    ip: 'anime',    detect: (t) => has(t, 'demon slayer', 'kimetsu', 'tanjiro', 'nezuko') },
  { id: 'blue-archive',    ip: 'game',     detect: (t) => has(t, 'blue archive') },
  { id: 'pokemon',         ip: 'game',     detect: (t) => has(t, 'pokemon', 'pikachu', 'eevee', 'snorlax') },
  // ── Disney ─────────────────────────────────────────────────────────────
  { id: 'winnie-the-pooh', ip: 'disney',   detect: (t) => has(t, 'winnie', 'winnie the pooh', 'pooh') },
  { id: 'judy-hopps',      ip: 'disney',   detect: (t) => has(t, 'judy hopps', 'judy', 'zootopia') },
  { id: 'stitch',          ip: 'disney',   detect: (t) => has(t, 'stitch', 'lilo') },
  { id: 'mickey-mouse',    ip: 'disney',   detect: (t) => has(t, 'mickey mouse', 'mickey', 'minnie mouse', 'minnie') },
  { id: 'dumbo',           ip: 'disney',   detect: (t) => has(t, 'dumbo') },
  { id: 'bambi',           ip: 'disney',   detect: (t) => has(t, 'bambi') },
  { id: 'sleeping-beauty', ip: 'disney',   detect: (t) => has(t, 'sleeping beauty', 'aurora', 'maleficent') },
  { id: 'alice',           ip: 'disney',   detect: (t) => has(t, 'alice in wonderland', 'alice wonderland') },
];

// ── Case style detection ──────────────────────────────────────────────────────

const STYLE_RULES = [
  { id: 'liquid-glitter',  detect: (t) => has(t, 'liquid glitter', 'quicksand', 'shaker glitter') },
  { id: 'glitter',         detect: (t) => has(t, 'glitter') },
  { id: 'leather',         detect: (t) => has(t, 'leather', 'faux leather', 'pu leather') },
  { id: 'wallet',          detect: (t) => has(t, 'wallet', 'card holder', 'card-holder', 'pocket', 'card slot') },
  { id: 'holographic',     detect: (t) => has(t, 'holographic', 'iridescent', 'rainbow chrome') },
  { id: 'embroidery',      detect: (t) => has(t, 'embroidery', 'embroidered') },
  { id: 'quilted',         detect: (t) => has(t, 'quilted') },
  { id: 'collage',         detect: (t) => has(t, 'collage') },
  { id: 'clear',           detect: (t) => has(t, 'clear', 'transparent') },
  { id: 'mirror',          detect: (t) => has(t, 'mirror', 'mirror case') },
  { id: 'silicone',        detect: (t) => has(t, 'silicone') },
  { id: 'rubber',          detect: (t) => has(t, 'rubber', 'soft case') },
  { id: '3d',              detect: (t) => has(t, '3d case', '3d cover', '3d design', 'raised') },
  { id: 'floral',          detect: (t) => has(t, 'floral', 'flower case') },
  { id: 'beaded',          detect: (t) => has(t, 'beaded', 'pearl beads', 'crystal') },
];

// ── Aesthetic detection ───────────────────────────────────────────────────────

const AESTHETIC_RULES = [
  { id: 'jirai-kei',  detect: (t) => has(t, 'jirai kei', 'jirai-kei', 'goth jirai', 'dark cute') },
  { id: 'coquette',   detect: (t) => has(t, 'coquette', 'lace', 'bow', 'rococo', 'hime gyaru', 'vintage lace') },
  { id: 'y2k',        detect: (t) => has(t, 'y2k', 'gyaru', 'leopard', 'animal print') },
  { id: 'pastel',     detect: (t) => has(t, 'pastel') },
  { id: 'kawaii',     detect: (t) => has(t, 'kawaii', 'cute', 'anime') },  // broad default
];

// ── Feature detection ─────────────────────────────────────────────────────────

const FEATURE_RULES = [
  { id: 'grip',        detect: (t) => has(t, 'grip', 'popsocket') },
  { id: 'charm',       detect: (t) => has(t, 'charm') },
  { id: 'ring-stand',  detect: (t) => has(t, 'ring stand', 'ring-stand', 'ring holder') },
  { id: 'card-holder', detect: (t) => has(t, 'card holder', 'card-holder', 'wallet') },
  { id: 'hand-strap',  detect: (t) => has(t, 'hand strap', 'hand-strap', 'wrist strap') },
  { id: 'shaker',      detect: (t) => has(t, 'shaker', 'quicksand', 'liquid') },
  { id: 'stand',       detect: (t) => has(t, 'stand') },
];

// ── Product type detection ────────────────────────────────────────────────────

function detectProductType(title) {
  const t = title.toLowerCase();
  if (has(t, 'airpod', 'air pod', 'earphone case', 'earbud case')) return 'airpod-case';
  if (has(t, 'apple watch', 'watch band', 'watch strap')) return 'watch-strap';
  if (has(t, 'popsocket', 'pop socket')) return 'popsocket';
  if (has(t, 'charm') && !has(t, 'case') && !has(t, 'cover')) return 'charm';
  // Default — iPhone/Samsung case
  return 'phone-case';
}

// ── Device brand detection ────────────────────────────────────────────────────

function detectDeviceBrand(title, variantTitles = []) {
  const t = title.toLowerCase();
  const v = variantTitles.join(' ').toLowerCase();
  const all = t + ' ' + v;
  if (has(all, 'iphone', 'ios')) return 'iphone';
  if (has(all, 'samsung', 'galaxy', 'android')) return 'samsung';
  if (has(all, 'pixel', 'google pixel')) return 'google';
  return 'universal';
}

// ── Attachment detection ──────────────────────────────────────────────────────

function detectAttachment(title, existingTags) {
  const tags = tagSet(existingTags);
  if (has(title, 'magsafe', 'mag safe', 'mag-safe') || tags.has('magsafe')) return 'magsafe';
  if (has(title, 'adhesive', 'sticky')) return 'adhesive';
  return 'standard';
}

// ── Clean legacy tags ─────────────────────────────────────────────────────────

// Tags that are too generic or mis-cased to keep
const LEGACY_TAGS_TO_REMOVE = new Set([
  // Too generic — applied to all 29 products, zero differentiation
  'cute gift', 'gift for her', 'cute iphone case', 'iphone 17 pro max',
  // Mis-cased duplicates
  'cinnamoroll', 'zootopia', 'chiikawa',
  // Misspelled
  'winne the pooh gift', 'cute winne the pooh',
  // Overly specific / redundant combos
  'cinnamoroll iphone', 'cinnamoroll gift her', 'hello iphone case',
  'kitty iphone case', 'melody iphone case', 'melody phone case',
  'cute melody', 'cute melody gift', 'pink hello case', 'pink kitty case',
  'cute judy gift', 'judy gift', 'judy iphone case', 'nick iphone case',
  'zootopia gift', 'zootopia iphone case', 'cute kuromi case',
  'kuromi iphone case', 'clear kuromi case', 'kuromi phone case',
  'chiikawa case', 'chiikawa gift', 'chiikawa iphone case', 'clear chiikawa case',
  'chiikawa magsafe', 'magsafe iphone case', 'hello kitty iphone',
  'red kitty case', 'clear kitty case', 'leopard hello kitty',
  'leopard iphone case', 'best friend gift', 'sweet piano case',
  'sweet piano iphone', 'cute miku case', 'cute miku iphone',
  'miku iphone case', 'miku phone case', 'pink phone case',
  'pooh iphone case', 'winnie iphone case', 'orange iphone case',
  'purple iphone case', 'blue iphone case', 'blue phone case',
  'pink iphone case', 'pink my melody', 'my melody case',
  'hello kitty magsafe', 'sanrio iphone case', 'disney iphone case',
  'judy', 'miku', 'kuromi', 'sweet piano',
]);

// Clean non-prefixed tags to keep (for storefront search + backward compat)
const LEGACY_TAGS_TO_KEEP = new Set([
  'y2kase', 'sanrio', 'disney', 'hello kitty', 'my melody',
  'cinnamoroll gift', 'cinnamoroll case', 'hello kitty case', 'hello kitty gift',
  'my melody gift', 'kuromi gift', 'miku gift',
  'magsafe', 'melody gift',
]);

// ── Master classifier ─────────────────────────────────────────────────────────

export function classifyProduct(product) {
  const title = product.title;
  const existingTags = product.tags || '';
  const variantTitles = (product.variants || []).map(v => v.title);

  // Detect all dimensions
  const productType  = detectProductType(title);
  const deviceBrand  = detectDeviceBrand(title, variantTitles);
  const attachment   = detectAttachment(title, existingTags);

  const characters  = CHARACTER_RULES.filter(r => r.detect(title)).map(r => r.id);
  const ipBrands    = [...new Set(CHARACTER_RULES.filter(r => r.detect(title)).map(r => r.ip))];
  const styles      = STYLE_RULES.filter(r => r.detect(title)).map(r => r.id);
  const aesthetics  = AESTHETIC_RULES.filter(r => r.detect(title)).map(r => r.id);
  const features    = FEATURE_RULES.filter(r => r.detect(title)).map(r => r.id);

  // Build new prefixed tag set
  const newTags = new Set();

  // Taxonomy prefixed tags
  newTags.add(`type:${productType}`);
  newTags.add(`device:${deviceBrand}`);
  newTags.add(`attach:${attachment}`);
  characters.forEach(c  => newTags.add(`char:${c}`));
  ipBrands.forEach(ip   => newTags.add(`ip:${ip}`));
  styles.forEach(s      => newTags.add(`style:${s}`));
  aesthetics.forEach(a  => newTags.add(`aesthetic:${a}`));
  features.forEach(f    => newTags.add(`feature:${f}`));

  // Preserve clean legacy tags
  const existingSet = tagSet(existingTags);
  for (const tag of existingSet) {
    if (!LEGACY_TAGS_TO_REMOVE.has(tag) || LEGACY_TAGS_TO_KEEP.has(tag)) {
      newTags.add(tag);
    }
  }
  // Always keep brand tag
  newTags.add('y2kase');

  return {
    id: product.id,
    title,
    productType,
    deviceBrand,
    attachment,
    characters,
    ipBrands,
    styles,
    aesthetics,
    features,
    finalTags: [...newTags].sort(),
    // Shopify product type field value
    shopifyProductType: productType === 'phone-case'
      ? (deviceBrand === 'iphone' ? 'iPhone Case' : deviceBrand === 'samsung' ? 'Samsung Case' : 'Phone Case')
      : productType === 'airpod-case'  ? 'AirPod Case'
      : productType === 'watch-strap'  ? 'Watch Strap'
      : productType === 'popsocket'    ? 'PopSocket'
      : productType === 'charm'        ? 'Charm'
      : 'Accessory',
    // Shopify Standard Product Category (Google taxonomy ID)
    standardCategory: 'gid://shopify/TaxonomyCategory/sg-4-17-2', // Electronics > Communications > Telephony > Mobile Phone Accessories > Mobile Phone Cases
  };
}
