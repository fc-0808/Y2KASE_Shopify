/**
 * Y2KASE Collection Logic
 *
 * Maps the classifier's structured output (characters, ipBrands, aesthetics,
 * attachment, productType) to Shopify Collection GIDs for the productSet
 * mutation's `collectionsToJoin` field.
 *
 * DESIGN PRINCIPLE:
 *   Map keys use the exact same "dimension:value" format that classifier.mjs
 *   emits as tags (char:cinnamoroll, ip:sanrio, attach:magsafe …).  The lookup
 *   is therefore a direct O(1) index per classifier output — zero extra regex,
 *   zero extra string comparisons.
 *
 * GID STATUS:
 *   ✅ LIVE  — real Shopify Collection ID fetched from y2kase-1435.myshopify.com
 *   🔲 TODO  — collection not yet created; entry is kept for dashboard chip display
 *              but is excluded from the collectionsToJoin API call automatically.
 *
 * USAGE (from transform.mjs):
 *   import { getCollectionData } from './collection-logic.mjs';
 *
 *   // Pass the already-computed classification object to avoid classifying twice.
 *   const collectionData = getCollectionData(classification);
 *   // collectionData.collectionIds → string[] of LIVE GIDs for collectionsToJoin
 *   // collectionData.collections  → [{gid, label, level, handle, live}] for dashboard chips
 *   // collectionData.tags         → string[] of additional tags to merge
 */

import { classifyProduct } from '../taxonomy/classifier.mjs';

// ── Master Collection Map ─────────────────────────────────────────────────────
//
// Every entry:  { gid, label, level, handle }
//   gid    — Shopify Collection GID.
//            ✅ LIVE  → real gid://shopify/Collection/NNNN from the store.
//            🔲 TODO  → still a placeholder; excluded from collectionsToJoin.
//   label  — Human-readable name shown as a chip in the After Pane.
//   level  — Hierarchy tier (1–7) used for chip colour coding.
//   handle — Shopify collection handle (for reference / admin deep-links).
//
// NOTE: vocaloid/game share the anime collection GID intentionally.
// GID deduplication in getCollectionData() ensures only one entry is emitted.

export const COLLECTION_MAP = {

  // ── Level 1: Product Type ────────────────────────────────────────────────
  'type:phone-case':  { gid: 'gid://shopify/Collection/302785757261', label: 'iPhone Cases',          level: 1, handle: 'iphone-cases'      }, // ✅ LIVE
  'type:airpod-case': { gid: 'gid://shopify/Collection/302785822797', label: 'AirPod Cases',          level: 1, handle: 'airpod-cases'      }, // ✅ LIVE
  'type:watch-strap': { gid: 'gid://shopify/Collection/302785855565', label: 'Apple Watch Straps',    level: 1, handle: 'apple-watch-straps' }, // ✅ LIVE
  'type:popsocket':   { gid: 'gid://shopify/Collection/302785888333', label: 'PopSockets & Grips',    level: 1, handle: 'popsockets'         }, // ✅ LIVE
  'type:charm':       { gid: 'gid://shopify/Collection/302785921101', label: 'Charms',                level: 1, handle: 'charms'             }, // ✅ LIVE

  // ── Level 2: Attachment Technology ──────────────────────────────────────
  'attach:magsafe':   { gid: 'gid://shopify/Collection/302785134669', label: 'MagSafe Cases',         level: 2, handle: 'magsafe'            }, // ✅ LIVE
  'attach:standard':  { gid: 'gid://shopify/Collection/302785167437', label: 'Standard Cases',        level: 2, handle: 'standard-cases'     }, // ✅ LIVE

  // ── Level 3: Cross-Dimension ─────────────────────────────────────────────
  'cross:magsafe-iphone': { gid: 'gid://shopify/Collection/302785200205', label: 'MagSafe iPhone Cases', level: 3, handle: 'magsafe-iphone-cases' }, // ✅ LIVE

  // ── Level 4: IP / Franchise Brand ────────────────────────────────────────
  'ip:sanrio':    { gid: 'gid://shopify/Collection/302785232973', label: 'Sanrio',           level: 4, handle: 'sanrio'    }, // ✅ LIVE
  'ip:disney':    { gid: 'gid://shopify/Collection/302785265741', label: 'Disney',           level: 4, handle: 'disney'    }, // ✅ LIVE
  'ip:anime':     { gid: 'gid://shopify/Collection/302785298509', label: 'Anime & Vocaloid', level: 4, handle: 'anime'     }, // ✅ LIVE
  'ip:vocaloid':  { gid: 'gid://shopify/Collection/302785298509', label: 'Anime & Vocaloid', level: 4, handle: 'anime'     }, // ✅ LIVE (shares anime)
  'ip:game':      { gid: 'gid://shopify/Collection/302785298509', label: 'Anime & Vocaloid', level: 4, handle: 'anime'     }, // ✅ LIVE (shares anime)
  'ip:peanuts':   { gid: 'gid://shopify/Collection/PLACEHOLDER_PEANUTS',   label: 'Peanuts / Snoopy',   level: 4, handle: 'peanuts'   }, // 🔲 TODO
  'ip:san-x':     { gid: 'gid://shopify/Collection/PLACEHOLDER_SAN_X',     label: 'San-X',              level: 4, handle: 'san-x'     }, // 🔲 TODO
  'ip:bandai':    { gid: 'gid://shopify/Collection/PLACEHOLDER_BANDAI',    label: 'Bandai',             level: 4, handle: 'bandai'    }, // 🔲 TODO
  'ip:sekiguchi': { gid: 'gid://shopify/Collection/PLACEHOLDER_SEKIGUCHI', label: 'Sekiguchi',          level: 4, handle: 'sekiguchi' }, // 🔲 TODO
  'ip:japanese':  { gid: 'gid://shopify/Collection/PLACEHOLDER_JAPANESE',  label: 'Japanese Culture',   level: 4, handle: 'japanese'  }, // 🔲 TODO
  'ip:indie':     { gid: 'gid://shopify/Collection/PLACEHOLDER_INDIE',     label: 'Indie & Original',   level: 4, handle: 'indie'     }, // 🔲 TODO

  // ── Level 5: Individual Characters ──────────────────────────────────────
  // Sanrio — live collections ───────────────────────────────────────────
  'char:hello-kitty':       { gid: 'gid://shopify/Collection/302785331277', label: 'Hello Kitty',         level: 5, handle: 'hello-kitty'        }, // ✅ LIVE
  'char:my-melody':         { gid: 'gid://shopify/Collection/302785364045', label: 'My Melody',           level: 5, handle: 'my-melody'          }, // ✅ LIVE
  'char:cinnamoroll':       { gid: 'gid://shopify/Collection/302785396813', label: 'Cinnamoroll',         level: 5, handle: 'cinnamoroll'        }, // ✅ LIVE
  'char:kuromi':            { gid: 'gid://shopify/Collection/302785429581', label: 'Kuromi',              level: 5, handle: 'kuromi'             }, // ✅ LIVE
  // Sanrio — pending collections ────────────────────────────────────────
  'char:pompompurin':       { gid: 'gid://shopify/Collection/PLACEHOLDER_POMPOMPURIN',       label: 'Pompompurin',         level: 5, handle: 'pompompurin'        }, // 🔲 TODO
  'char:pochacco':          { gid: 'gid://shopify/Collection/PLACEHOLDER_POCHACCO',          label: 'Pochacco',            level: 5, handle: 'pochacco'           }, // 🔲 TODO
  'char:keroppi':           { gid: 'gid://shopify/Collection/PLACEHOLDER_KEROPPI',           label: 'Keroppi',             level: 5, handle: 'keroppi'            }, // 🔲 TODO
  'char:tuxedo-sam':        { gid: 'gid://shopify/Collection/PLACEHOLDER_TUXEDO_SAM',        label: 'Tuxedo Sam',          level: 5, handle: 'tuxedo-sam'         }, // 🔲 TODO
  'char:little-twin-stars': { gid: 'gid://shopify/Collection/PLACEHOLDER_LITTLE_TWIN_STARS', label: 'Little Twin Stars',   level: 5, handle: 'little-twin-stars'  }, // 🔲 TODO
  'char:badtz-maru':        { gid: 'gid://shopify/Collection/PLACEHOLDER_BADTZ_MARU',        label: 'Badtz-Maru',          level: 5, handle: 'badtz-maru'         }, // 🔲 TODO
  'char:hangyodon':         { gid: 'gid://shopify/Collection/PLACEHOLDER_HANGYODON',         label: 'Hangyodon',           level: 5, handle: 'hangyodon'          }, // 🔲 TODO
  'char:cogimyun':          { gid: 'gid://shopify/Collection/PLACEHOLDER_COGIMYUN',          label: 'Cogimyun',            level: 5, handle: 'cogimyun'           }, // 🔲 TODO
  'char:wish-me-mell':      { gid: 'gid://shopify/Collection/PLACEHOLDER_WISH_ME_MELL',      label: 'Wish Me Mell',        level: 5, handle: 'wish-me-mell'       }, // 🔲 TODO
  'char:aggretsuko':        { gid: 'gid://shopify/Collection/PLACEHOLDER_AGGRETSUKO',        label: 'Aggretsuko',          level: 5, handle: 'aggretsuko'         }, // 🔲 TODO
  'char:gudetama':          { gid: 'gid://shopify/Collection/PLACEHOLDER_GUDETAMA',          label: 'Gudetama',            level: 5, handle: 'gudetama'           }, // 🔲 TODO
  'char:cinnamoangels':     { gid: 'gid://shopify/Collection/PLACEHOLDER_CINNAMOANGELS',     label: 'Cinnamoangels',       level: 5, handle: 'cinnamoangels'      }, // 🔲 TODO
  'char:charmmy-kitty':     { gid: 'gid://shopify/Collection/PLACEHOLDER_CHARMMY_KITTY',     label: 'Charmmy Kitty',       level: 5, handle: 'charmmy-kitty'      }, // 🔲 TODO
  // Anime / Indie IP — live ─────────────────────────────────────────────
  'char:chiikawa':          { gid: 'gid://shopify/Collection/302785462349', label: 'Chiikawa',            level: 5, handle: 'chiikawa'           }, // ✅ LIVE
  'char:hatsune-miku':      { gid: 'gid://shopify/Collection/302785495117', label: 'Hatsune Miku',        level: 5, handle: 'hatsune-miku'       }, // ✅ LIVE
  // Anime — pending ─────────────────────────────────────────────────────
  'char:sailor-moon':       { gid: 'gid://shopify/Collection/PLACEHOLDER_SAILOR_MOON',       label: 'Sailor Moon',         level: 5, handle: 'sailor-moon'        }, // 🔲 TODO
  'char:cardcaptor-sakura': { gid: 'gid://shopify/Collection/PLACEHOLDER_CARDCAPTOR_SAKURA', label: 'Cardcaptor Sakura',   level: 5, handle: 'cardcaptor-sakura'  }, // 🔲 TODO
  'char:tokyo-mew-mew':     { gid: 'gid://shopify/Collection/PLACEHOLDER_TOKYO_MEW_MEW',     label: 'Tokyo Mew Mew',       level: 5, handle: 'tokyo-mew-mew'      }, // 🔲 TODO
  'char:precure':           { gid: 'gid://shopify/Collection/PLACEHOLDER_PRECURE',           label: 'Pretty Cure',         level: 5, handle: 'precure'            }, // 🔲 TODO
  'char:ghibli':            { gid: 'gid://shopify/Collection/PLACEHOLDER_GHIBLI',            label: 'Studio Ghibli',       level: 5, handle: 'ghibli'             }, // 🔲 TODO
  'char:jujutsu-kaisen':    { gid: 'gid://shopify/Collection/PLACEHOLDER_JUJUTSU_KAISEN',    label: 'Jujutsu Kaisen',      level: 5, handle: 'jujutsu-kaisen'     }, // 🔲 TODO
  'char:demon-slayer':      { gid: 'gid://shopify/Collection/PLACEHOLDER_DEMON_SLAYER',      label: 'Demon Slayer',        level: 5, handle: 'demon-slayer'       }, // 🔲 TODO
  'char:blue-archive':      { gid: 'gid://shopify/Collection/PLACEHOLDER_BLUE_ARCHIVE',      label: 'Blue Archive',        level: 5, handle: 'blue-archive'       }, // 🔲 TODO
  'char:pokemon':           { gid: 'gid://shopify/Collection/PLACEHOLDER_POKEMON',           label: 'Pokémon',             level: 5, handle: 'pokemon'            }, // 🔲 TODO
  // Disney — live ───────────────────────────────────────────────────────
  'char:winnie-the-pooh':   { gid: 'gid://shopify/Collection/302785527885', label: 'Winnie the Pooh',     level: 5, handle: 'winnie-the-pooh'    }, // ✅ LIVE
  'char:judy-hopps':        { gid: 'gid://shopify/Collection/302785560653', label: 'Zootopia',            level: 5, handle: 'zootopia'           }, // ✅ LIVE
  // Disney — pending ────────────────────────────────────────────────────
  'char:stitch':            { gid: 'gid://shopify/Collection/PLACEHOLDER_STITCH',            label: 'Stitch',              level: 5, handle: 'stitch'             }, // 🔲 TODO
  'char:mickey-mouse':      { gid: 'gid://shopify/Collection/PLACEHOLDER_MICKEY_MOUSE',      label: 'Mickey Mouse',        level: 5, handle: 'mickey-mouse'       }, // 🔲 TODO
  'char:dumbo':             { gid: 'gid://shopify/Collection/PLACEHOLDER_DUMBO',             label: 'Dumbo',               level: 5, handle: 'dumbo'              }, // 🔲 TODO
  'char:bambi':             { gid: 'gid://shopify/Collection/PLACEHOLDER_BAMBI',             label: 'Bambi',               level: 5, handle: 'bambi'              }, // 🔲 TODO
  'char:sleeping-beauty':   { gid: 'gid://shopify/Collection/PLACEHOLDER_SLEEPING_BEAUTY',   label: 'Sleeping Beauty',     level: 5, handle: 'sleeping-beauty'    }, // 🔲 TODO
  'char:alice':             { gid: 'gid://shopify/Collection/PLACEHOLDER_ALICE',             label: 'Alice in Wonderland', level: 5, handle: 'alice'              }, // 🔲 TODO
  // Peanuts — pending ───────────────────────────────────────────────────
  'char:snoopy':            { gid: 'gid://shopify/Collection/PLACEHOLDER_SNOOPY',            label: 'Snoopy / Peanuts',    level: 5, handle: 'snoopy'             }, // 🔲 TODO
  // Bandai / Retro — pending ────────────────────────────────────────────
  'char:tamagotchi':        { gid: 'gid://shopify/Collection/PLACEHOLDER_TAMAGOTCHI',        label: 'Tamagotchi',          level: 5, handle: 'tamagotchi'         }, // 🔲 TODO
  'char:monchhichi':        { gid: 'gid://shopify/Collection/PLACEHOLDER_MONCHHICHI',        label: 'Monchhichi',          level: 5, handle: 'monchhichi'         }, // 🔲 TODO
  // San-X — pending ─────────────────────────────────────────────────────
  'char:rilakkuma':         { gid: 'gid://shopify/Collection/PLACEHOLDER_RILAKKUMA',         label: 'Rilakkuma',           level: 5, handle: 'rilakkuma'          }, // 🔲 TODO
  'char:sumikko':           { gid: 'gid://shopify/Collection/PLACEHOLDER_SUMIKKO',           label: 'Sumikko Gurashi',     level: 5, handle: 'sumikko-gurashi'    }, // 🔲 TODO
  // Indie / Original — pending ──────────────────────────────────────────
  'char:sleepy-star':       { gid: 'gid://shopify/Collection/PLACEHOLDER_SLEEPY_STAR',       label: 'Sleepy Star',         level: 5, handle: 'sleepy-star'        }, // 🔲 TODO
  'char:maneki-neko':       { gid: 'gid://shopify/Collection/PLACEHOLDER_MANEKI_NEKO',       label: 'Maneki Neko',         level: 5, handle: 'maneki-neko'        }, // 🔲 TODO

  // ── Level 6: Visual Aesthetic ────────────────────────────────────────────
  'aesthetic:kawaii':    { gid: 'gid://shopify/Collection/302785691725', label: 'Kawaii',              level: 6, handle: 'kawaii'     }, // ✅ LIVE
  'aesthetic:coquette':  { gid: 'gid://shopify/Collection/302785593421', label: 'Coquette Aesthetic',  level: 6, handle: 'coquette'   }, // ✅ LIVE
  'aesthetic:y2k':       { gid: 'gid://shopify/Collection/302785626189', label: 'Y2K & Gyaru',         level: 6, handle: 'y2k'        }, // ✅ LIVE
  'aesthetic:jirai-kei': { gid: 'gid://shopify/Collection/302785658957', label: 'Dark Cute',           level: 6, handle: 'dark-cute'  }, // ✅ LIVE
  'aesthetic:pastel':    { gid: 'gid://shopify/Collection/302785691725', label: 'Kawaii',              level: 6, handle: 'kawaii'     }, // ✅ LIVE (shares kawaii)

  // ── Level 7: Catch-All ───────────────────────────────────────────────────
  'all': { gid: 'gid://shopify/Collection/302785724493', label: 'All Products', level: 7, handle: 'all' }, // ✅ LIVE
};

// ── getCollectionData ─────────────────────────────────────────────────────────
//
// Accepts either:
//   • A pre-computed classification object (output of classifyProduct()).
//     Pass this form from buildShopifyPayload() to avoid classifying twice.
//   • A raw title string — classifyProduct() is called internally (useful for
//     one-off lookups or tests outside the transform pipeline).
//
// Returns:
//   collections   — ALL matched entries ordered most-specific → least-specific,
//                   including 🔲 TODO entries (shown as dashed chips in the
//                   dashboard so the operator can see what's pending).
//
//   collectionIds — LIVE GIDs only (no PLACEHOLDERs), ready to drop directly
//                   into Shopify's productSet mutation as `collectionsToJoin`.
//
//   tags          — supplementary "character:*" / "brand:*" tag strings to
//                   merge into the payload's tags array.

export function getCollectionData(input) {
  const cl = typeof input === 'string'
    ? classifyProduct({ title: input, tags: '', variants: [] })
    : input;

  const seenGids  = new Set();
  const collected = [];

  const push = (key) => {
    const entry = COLLECTION_MAP[key];
    // Skip unknown keys or GIDs already added (handles shared GIDs like
    // vocaloid/game → anime collection).
    if (!entry || seenGids.has(entry.gid)) return;
    seenGids.add(entry.gid);
    // Mark whether this GID is live or still a placeholder.
    const live = !entry.gid.includes('PLACEHOLDER');
    collected.push({ ...entry, key, live });
  };

  // ── Dimension walk (most → least specific) ────────────────────────────────

  // Level 5 — character collections are the most relevant storefront pages.
  for (const char of cl.characters)   push(`char:${char}`);

  // Level 4 — parent IP/franchise.
  for (const ip  of cl.ipBrands)      push(`ip:${ip}`);

  // Level 6 — aesthetic cross-collection.
  for (const aes of cl.aesthetics)    push(`aesthetic:${aes}`);

  // Level 3 — cross-dimension MagSafe × iPhone (narrower than Level 2).
  if (cl.deviceBrand === 'iphone' && cl.attachment === 'magsafe') {
    push('cross:magsafe-iphone');
  }

  // Level 2 — attachment technology.
  push(`attach:${cl.attachment}`);

  // Level 1 — product type.
  push(`type:${cl.productType}`);

  // Level 7 — every product belongs to "All Products".
  push('all');

  // ── Supplementary storefront tags ─────────────────────────────────────────
  // "character:cinnamoroll", "brand:sanrio" format as requested in the spec.
  // The merge in transform.mjs deduplicates via a Set, so overlap with the
  // classifier's "char:*" / "ip:*" tags is silently dropped.
  const tags = [];
  for (const char of cl.characters) tags.push(`character:${char}`);
  for (const ip   of cl.ipBrands)   tags.push(`brand:${ip}`);

  return {
    // Full list (including TODO entries) — used for dashboard chip display.
    collections:  collected,
    // LIVE GIDs only — sent to Shopify's productSet collectionsToJoin field.
    collectionIds: collected.filter(c => c.live).map(c => c.gid),
    tags:          [...new Set(tags)],
  };
}
