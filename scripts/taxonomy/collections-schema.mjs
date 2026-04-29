/**
 * Y2KASE Collection Schema
 *
 * Defines every collection Y2KASE will have — now and in the future.
 * Collections use smart rules so future products auto-populate with zero maintenance.
 *
 * ARCHITECTURE:
 *  Level 1 — Product Category (what it IS)
 *  Level 2 — Device Brand (what it fits)
 *  Level 3 — Attachment Type (MagSafe vs standard vs adhesive)
 *  Level 4 — IP / Franchise (Sanrio, Disney, Anime)
 *  Level 5 — Character (Hello Kitty, My Melody, etc.)
 *  Level 6 — Aesthetic (Kawaii, Coquette, Y2K, Dark Cute)
 *  Level 7 — Gift / Promo (editorial collections)
 */

// Rule helpers
const tagRule = (tag) => ({ column: 'tag', relation: 'equals', condition: tag });
const typeRule = (type) => ({ column: 'type', relation: 'equals', condition: type });
const priceRule = (max) => ({ column: 'variant_price', relation: 'less_than', condition: String(max) });

export const COLLECTIONS = [

  // ── LEVEL 1: Product Category ──────────────────────────────────────────────
  // These are the backbone. One product_type per product = auto-organised forever.

  {
    handle: 'iphone-cases',
    title: 'iPhone Cases',
    body_html: '<p>Kawaii &amp; aesthetic iPhone cases — MagSafe, glitter, leather, wallet &amp; more. Compatible with iPhone 17, 16, 15, 14 series.</p>',
    disjunctive: false,
    rules: [typeRule('iPhone Case')],
    sort_order: 'best-selling',
    level: 1,
    note: 'All current iPhone cases',
    published: true,
  },
  {
    handle: 'samsung-cases',
    title: 'Samsung Cases',
    body_html: '<p>Kawaii Samsung Galaxy cases — coming soon.</p>',
    disjunctive: false,
    rules: [typeRule('Samsung Case')],
    sort_order: 'best-selling',
    level: 1,
    note: 'Future-ready — empty until Samsung products added',
    published: false, // hidden until populated
  },
  {
    handle: 'airpod-cases',
    title: 'AirPod Cases',
    body_html: '<p>Kawaii AirPod &amp; earphone cases — coming soon.</p>',
    disjunctive: false,
    rules: [typeRule('AirPod Case')],
    sort_order: 'best-selling',
    level: 1,
    note: 'Future-ready — empty until AirPod products added',
    published: false,
  },
  {
    handle: 'apple-watch-straps',
    title: 'Apple Watch Straps',
    body_html: '<p>Kawaii Apple Watch bands — coming soon.</p>',
    disjunctive: false,
    rules: [typeRule('Watch Strap')],
    sort_order: 'best-selling',
    level: 1,
    note: 'Future-ready',
    published: false,
  },
  {
    handle: 'popsockets',
    title: 'PopSockets & Grips',
    body_html: '<p>MagSafe and adhesive PopSockets &amp; phone grips — coming soon.</p>',
    disjunctive: false,
    rules: [typeRule('PopSocket')],
    sort_order: 'best-selling',
    level: 1,
    note: 'Future-ready',
    published: false,
  },
  {
    handle: 'charms',
    title: 'Charms',
    body_html: '<p>Kawaii phone charms, bag charms &amp; accessories.</p>',
    disjunctive: false,
    rules: [typeRule('Charm')],
    sort_order: 'best-selling',
    level: 1,
    note: 'Future-ready — currently charms are bundled with cases as variants',
    published: false,
  },

  // ── LEVEL 2: Attachment Technology ────────────────────────────────────────

  {
    handle: 'magsafe',
    title: 'MagSafe Cases',
    body_html: '<p>MagSafe-compatible cases for iPhone 12 and newer. Snap-on magnetic attachment — works with all MagSafe accessories and chargers.</p>',
    disjunctive: false,
    rules: [tagRule('attach:magsafe')],
    sort_order: 'best-selling',
    level: 2,
    note: 'Key collection — drives upsell on MagSafe grips + chargers',
    published: true,
  },
  {
    handle: 'standard-cases',
    title: 'Standard Cases',
    body_html: '<p>Classic phone cases without MagSafe. Glitter, leather, wallet, holographic styles.</p>',
    disjunctive: false,
    rules: [tagRule('attach:standard')],
    sort_order: 'best-selling',
    level: 2,
    note: 'Non-MagSafe cases',
    published: true,
  },

  // ── LEVEL 3: MagSafe by Device (cross-dimension) ──────────────────────────

  {
    handle: 'magsafe-iphone-cases',
    title: 'MagSafe iPhone Cases',
    body_html: '<p>MagSafe-compatible kawaii iPhone cases. Compatible with iPhone 12 and newer.</p>',
    disjunctive: false,  // AND — must match both rules
    rules: [tagRule('attach:magsafe'), tagRule('device:iphone')],
    sort_order: 'best-selling',
    level: 3,
    note: 'High-value cross-dimension collection',
    published: true,
  },

  // ── LEVEL 4: IP / Franchise Brand ─────────────────────────────────────────

  {
    handle: 'sanrio',
    title: 'Sanrio',
    body_html: '<p>Official Sanrio character cases — Hello Kitty, My Melody, Cinnamoroll, Kuromi &amp; more.</p>',
    disjunctive: false,
    rules: [tagRule('ip:sanrio')],
    sort_order: 'best-selling',
    level: 4,
    note: 'Parent collection for all Sanrio characters',
    published: true,
  },
  {
    handle: 'disney',
    title: 'Disney',
    body_html: '<p>Disney character phone cases — Winnie the Pooh, Zootopia &amp; more.</p>',
    disjunctive: false,
    rules: [tagRule('ip:disney')],
    sort_order: 'best-selling',
    level: 4,
    note: 'Parent collection for Disney characters',
    published: true,
  },
  {
    handle: 'anime',
    title: 'Anime & Vocaloid',
    body_html: '<p>Anime character phone cases — Chiikawa, Hatsune Miku &amp; more.</p>',
    disjunctive: true,   // OR — either tag matches
    rules: [tagRule('ip:anime'), tagRule('ip:vocaloid')],
    sort_order: 'best-selling',
    level: 4,
    note: 'Non-Sanrio, non-Disney anime/game characters',
    published: true,
  },

  // ── LEVEL 5: Individual Characters ────────────────────────────────────────

  {
    handle: 'hello-kitty',
    title: 'Hello Kitty',
    body_html: '<p>Hello Kitty iPhone cases — MagSafe, glitter, leather, coquette, Y2K &amp; more.</p>',
    disjunctive: false,
    rules: [tagRule('char:hello-kitty')],
    sort_order: 'best-selling',
    level: 5,
    note: 'Highest volume character — 12 products',
    published: true,
  },
  {
    handle: 'my-melody',
    title: 'My Melody',
    body_html: '<p>My Melody iPhone cases — sweet, pastel &amp; kawaii designs.</p>',
    disjunctive: false,
    rules: [tagRule('char:my-melody')],
    sort_order: 'best-selling',
    level: 5,
    note: '11 products including Sweet Piano sub-character',
    published: true,
  },
  {
    handle: 'cinnamoroll',
    title: 'Cinnamoroll',
    body_html: '<p>Cinnamoroll iPhone cases — fluffy, blue &amp; cloud aesthetic designs.</p>',
    disjunctive: false,
    rules: [tagRule('char:cinnamoroll')],
    sort_order: 'best-selling',
    level: 5,
    note: '3 products now',
    published: true,
  },
  {
    handle: 'kuromi',
    title: 'Kuromi',
    body_html: '<p>Kuromi iPhone cases — dark kawaii, jirai kei &amp; gothic cute designs.</p>',
    disjunctive: false,
    rules: [tagRule('char:kuromi')],
    sort_order: 'best-selling',
    level: 5,
    note: 'Trending dark kawaii — expand stock',
    published: true,
  },
  {
    handle: 'chiikawa',
    title: 'Chiikawa',
    body_html: '<p>Chiikawa iPhone cases — cute anime character designs.</p>',
    disjunctive: false,
    rules: [tagRule('char:chiikawa')],
    sort_order: 'best-selling',
    level: 5,
    note: '1 product now',
    published: true,
  },
  {
    handle: 'hatsune-miku',
    title: 'Hatsune Miku',
    body_html: '<p>Hatsune Miku Vocaloid iPhone cases — teal, cute &amp; anime designs.</p>',
    disjunctive: false,
    rules: [tagRule('char:hatsune-miku')],
    sort_order: 'best-selling',
    level: 5,
    note: '1 product now',
    published: true,
  },
  {
    handle: 'winnie-the-pooh',
    title: 'Winnie the Pooh',
    body_html: '<p>Winnie the Pooh iPhone cases — warm, autumn &amp; kawaii designs.</p>',
    disjunctive: false,
    rules: [tagRule('char:winnie-the-pooh')],
    sort_order: 'best-selling',
    level: 5,
    note: '1 product now',
    published: true,
  },
  {
    handle: 'zootopia',
    title: 'Zootopia',
    body_html: '<p>Zootopia iPhone cases — Judy Hopps, Nick Wilde &amp; more.</p>',
    disjunctive: false,
    rules: [tagRule('char:judy-hopps')],
    sort_order: 'best-selling',
    level: 5,
    note: '2 products now',
    published: true,
  },

  // ── LEVEL 6: Aesthetics ────────────────────────────────────────────────────

  {
    handle: 'coquette',
    title: 'Coquette Aesthetic',
    body_html: '<p>Coquette &amp; feminine kawaii phone cases — lace, bows, leather &amp; pink designs.</p>',
    disjunctive: false,
    rules: [tagRule('aesthetic:coquette')],
    sort_order: 'best-selling',
    level: 6,
    note: 'Trending aesthetic — several HK + My Melody products',
    published: true,
  },
  {
    handle: 'y2k',
    title: 'Y2K & Gyaru',
    body_html: '<p>Y2K, gyaru &amp; retro-inspired phone cases.</p>',
    disjunctive: false,
    rules: [tagRule('aesthetic:y2k')],
    sort_order: 'best-selling',
    level: 6,
    note: 'Y2K aesthetic',
    published: true,
  },
  {
    handle: 'dark-cute',
    title: 'Dark Cute',
    body_html: '<p>Jirai kei, goth kawaii &amp; dark cute phone cases — Kuromi &amp; more.</p>',
    disjunctive: false,
    rules: [tagRule('aesthetic:jirai-kei')],
    sort_order: 'best-selling',
    level: 6,
    note: 'Jirai kei / dark kawaii niche',
    published: true,
  },
  {
    handle: 'kawaii',
    title: 'Kawaii',
    body_html: '<p>All things kawaii — cute, pastel &amp; adorable phone cases.</p>',
    disjunctive: false,
    rules: [tagRule('aesthetic:kawaii')],
    sort_order: 'best-selling',
    level: 6,
    note: 'Broad kawaii collection — most products',
    published: true,
  },

  // ── LEVEL 7: Gift / Promo ──────────────────────────────────────────────────

  {
    handle: 'all',
    title: 'All Products',
    body_html: '<p>Browse the full Y2KASE collection.</p>',
    disjunctive: false,
    rules: [tagRule('y2kase')],
    sort_order: 'best-selling',
    level: 7,
    note: 'Catch-all — every Y2KASE product',
    published: true,
  },
];
