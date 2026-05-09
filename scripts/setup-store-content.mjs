/**
 * Y2KASE Store Content Setup
 * Creates: Policies · Pages · Navigation Menus · SEO-optimised product titles
 *
 * Run: node scripts/setup-store-content.mjs --dry-run
 *      node scripts/setup-store-content.mjs --apply
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../.env');

function loadEnv(f) {
  let t = readFileSync(f, 'utf8');
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  for (const line of t.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq === -1) continue;
    process.env[s.slice(0, eq).trim()] = s.slice(eq + 1).trim();
  }
}
loadEnv(envPath);

const SHOP    = process.env.SHOPIFY_SHOP;
const TOKEN   = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const VERSION = process.env.SHOPIFY_API_VERSION || '2026-04';
const BASE    = `https://${SHOP}/admin/api/${VERSION}`;
const GQL     = `${BASE}/graphql.json`;
const ARGS    = process.argv.slice(2);
const DRY     = !ARGS.includes('--apply');

if (DRY) console.log('\n⚠️  DRY RUN — pass --apply to execute\n');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rest = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method, headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  await sleep(400);
  return r.json();
};
const gql = async (query, variables = {}) => {
  const r = await fetch(GQL, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  await sleep(400);
  return r.json();
};

// ══════════════════════════════════════════════════════════════════════════════
// STEP 1: POLICIES
// ══════════════════════════════════════════════════════════════════════════════

const POLICIES = [
  {
    type: 'REFUND_POLICY',
    body: `<h1>Refund &amp; Return Policy</h1>
<p>We want you to love your Y2KASE order. If something isn't right, we're here to help.</p>
<h2>Returns</h2>
<p>We accept returns within <strong>30 days</strong> of delivery. Items must be unused, in original condition, and in original packaging.</p>
<p>To start a return, email us at <a href="mailto:hello@y2kase.com">hello@y2kase.com</a> with your order number and reason for return.</p>
<h2>Refunds</h2>
<p>Once your return is received and inspected, we will notify you by email. Approved refunds are processed within <strong>5–7 business days</strong> to your original payment method.</p>
<h2>Exchanges</h2>
<p>We offer exchanges for different variants (phone model, bundle option) within 30 days. Please contact us and we'll arrange a replacement.</p>
<h2>Damaged or Incorrect Items</h2>
<p>If your item arrives damaged or you received the wrong item, please contact us within <strong>7 days</strong> of delivery with photos and we'll send a replacement at no cost.</p>
<h2>Non-returnable Items</h2>
<ul><li>Items returned after 30 days</li><li>Items with visible wear or damage caused by the customer</li></ul>
<h2>Contact</h2>
<p>Email: <a href="mailto:hello@y2kase.com">hello@y2kase.com</a></p>`,
  },
  {
    type: 'SHIPPING_POLICY',
    body: `<h1>Shipping Policy</h1>
<h2>Processing Time</h2>
<p>Orders are processed within <strong>1–3 business days</strong> after payment confirmation. Orders placed on weekends or public holidays are processed the next business day.</p>
<h2>Shipping Times</h2>
<table>
<thead><tr><th>Destination</th><th>Standard</th><th>Express</th></tr></thead>
<tbody>
<tr><td>Hong Kong</td><td>1–3 days</td><td>Next day</td></tr>
<tr><td>United States</td><td>7–14 days</td><td>3–5 days</td></tr>
<tr><td>United Kingdom</td><td>7–14 days</td><td>3–5 days</td></tr>
<tr><td>European Union</td><td>7–14 days</td><td>3–7 days</td></tr>
<tr><td>Rest of World</td><td>10–21 days</td><td>5–10 days</td></tr>
</tbody>
</table>
<h2>Shipping Rates</h2>
<p>Shipping rates are calculated at checkout based on destination and order weight. Free shipping is available on qualifying orders — see current threshold at checkout.</p>
<h2>Tracking</h2>
<p>All orders include a tracking number sent by email once dispatched. You can track your order via the carrier's website.</p>
<h2>Customs &amp; Duties</h2>
<p>International orders may be subject to customs duties or import taxes, which are the buyer's responsibility. These fees are not included in our shipping rates.</p>
<h2>Contact</h2>
<p>For shipping enquiries: <a href="mailto:hello@y2kase.com">hello@y2kase.com</a></p>`,
  },
  {
    type: 'PRIVACY_POLICY',
    body: `<h1>Privacy Policy</h1>
<p>Y2KASE ("we", "us", "our") is committed to protecting your personal information. This policy explains how we collect, use, and protect your data.</p>
<h2>Information We Collect</h2>
<ul>
<li><strong>Order information:</strong> name, email, shipping address, payment details (processed securely by Shopify Payments)</li>
<li><strong>Device information:</strong> IP address, browser type, pages visited (via cookies)</li>
<li><strong>Marketing preferences:</strong> only if you opt in</li>
</ul>
<h2>How We Use Your Information</h2>
<ul>
<li>To process and fulfil your orders</li>
<li>To send order confirmations and shipping updates</li>
<li>To improve our store and customer experience</li>
<li>To send marketing emails (only with your consent)</li>
</ul>
<h2>Sharing Your Information</h2>
<p>We do not sell your personal data. We share information only with service providers necessary to operate our store (Shopify, shipping carriers, payment processors).</p>
<h2>Your Rights (GDPR)</h2>
<p>If you are located in the EU or UK, you have the right to access, correct, or delete your personal data. Contact us at <a href="mailto:hello@y2kase.com">hello@y2kase.com</a> to exercise these rights.</p>
<h2>Cookies</h2>
<p>We use cookies to maintain your shopping session, remember preferences, and analyse traffic. You can disable cookies in your browser settings.</p>
<h2>Data Retention</h2>
<p>We retain order data for 7 years for accounting purposes. You may request deletion of marketing data at any time.</p>
<h2>Contact</h2>
<p>Data controller: Y2KASE · Email: <a href="mailto:hello@y2kase.com">hello@y2kase.com</a></p>`,
  },
  {
    type: 'TERMS_OF_SERVICE',
    body: `<h1>Terms of Service</h1>
<p>By purchasing from Y2KASE, you agree to the following terms.</p>
<h2>Products</h2>
<p>All products are described as accurately as possible. Colours may vary slightly due to screen settings. We reserve the right to limit quantities or discontinue products.</p>
<h2>Pricing</h2>
<p>Prices are displayed in your local currency based on your location. All prices include applicable taxes where required by law. We reserve the right to change prices at any time.</p>
<h2>Orders</h2>
<p>Placing an order is an offer to purchase. We reserve the right to cancel any order due to pricing errors, stock issues, or suspected fraud. You will be notified and fully refunded if an order is cancelled.</p>
<h2>Intellectual Property</h2>
<p>All product images, descriptions, and branding are the property of Y2KASE or used under license. You may not reproduce or distribute our content without written permission.</p>
<h2>Character Licensing</h2>
<p>Sanrio characters (Hello Kitty, My Melody, Cinnamoroll, Kuromi) are trademarks of Sanrio Co., Ltd. Disney characters are trademarks of The Walt Disney Company. All character-based products are sold under the appropriate licensing arrangements.</p>
<h2>Limitation of Liability</h2>
<p>Y2KASE is not liable for any indirect, incidental, or consequential damages arising from the use of our products or services.</p>
<h2>Governing Law</h2>
<p>These terms are governed by the laws of Hong Kong SAR.</p>
<h2>Contact</h2>
<p>Email: <a href="mailto:hello@y2kase.com">hello@y2kase.com</a></p>`,
  },
];

console.log('\n══ STEP 1: POLICIES ══════════════════════════════════════════');
for (const policy of POLICIES) {
  if (DRY) { console.log(`  [DRY] Would set policy: ${policy.type}`); continue; }
  const result = await gql(`
    mutation shopPolicyUpdate($shopPolicy: ShopPolicyInput!) {
      shopPolicyUpdate(shopPolicy: $shopPolicy) {
        userErrors { field message }
      }
    }
  `, { shopPolicy: { type: policy.type, body: policy.body } });
  const errs = result.data?.shopPolicyUpdate?.userErrors;
  if (errs?.length) console.error(`  ❌ ${policy.type}:`, errs[0].message);
  else console.log(`  ✅ Set: ${policy.type}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// STEP 2: PAGES
// ══════════════════════════════════════════════════════════════════════════════

const PAGES = [
  {
    handle: 'about',
    title: 'About Y2KASE',
    body_html: `<h1>About Y2KASE</h1>
<p>Y2KASE is a kawaii phone accessories brand born from a love of cute aesthetics, anime culture, and the Y2K era. Based in Hong Kong, we design and curate phone cases, grips, and charms inspired by iconic characters and trending aesthetics.</p>
<h2>Our Story</h2>
<p>What started as a passion project on Etsy grew into a full brand dedicated to bringing high-quality, character-inspired phone accessories to fans around the world. Every case is designed with care — from the MagSafe grip mechanics to the hand-applied charms.</p>
<h2>Our Products</h2>
<p>We specialise in iPhone cases featuring beloved characters from Sanrio (Hello Kitty, My Melody, Cinnamoroll, Kuromi), Disney (Winnie the Pooh, Zootopia), and anime (Chiikawa, Hatsune Miku). Our cases come in a range of styles including MagSafe-compatible designs, liquid glitter, leather, wallet, and holographic finishes.</p>
<h2>Our Commitment</h2>
<ul>
<li>Quality materials and construction on every product</li>
<li>Fast, tracked shipping worldwide</li>
<li>30-day hassle-free returns</li>
<li>Genuine character licensing</li>
</ul>
<h2>Find Us</h2>
<p>Email: <a href="mailto:hello@y2kase.com">hello@y2kase.com</a><br>
Instagram: @y2kase<br>
TikTok: @y2kase</p>`,
  },
  {
    handle: 'faq',
    title: 'FAQ',
    body_html: `<h1>Frequently Asked Questions</h1>
<h2>Orders &amp; Shipping</h2>
<h3>How long does shipping take?</h3>
<p>Standard shipping takes 7–14 business days for international orders, and 1–3 days within Hong Kong. Express options are available at checkout. See our <a href="/pages/shipping">Shipping Policy</a> for full details.</p>
<h3>Can I track my order?</h3>
<p>Yes — all orders include a tracking number sent to your email once dispatched.</p>
<h3>Do you ship worldwide?</h3>
<p>Yes, we ship to most countries. Prices are shown in your local currency (USD, GBP, EUR, HKD) at checkout.</p>
<h2>Products</h2>
<h3>Are the MagSafe cases compatible with MagSafe chargers?</h3>
<p>Yes. All cases marked "MagSafe" contain built-in magnets aligned to Apple's MagSafe standard. They work with MagSafe chargers, MagSafe wallets, and other MagSafe accessories.</p>
<h3>Which iPhone models are compatible?</h3>
<p>Most of our cases are available for iPhone 14, 15, 16, and 17 series (including Pro and Pro Max). The specific models are listed on each product page. MagSafe functionality requires iPhone 12 or newer.</p>
<h3>Are the charms removable?</h3>
<p>Yes — all charms are attached via a keyring-style clip and can be removed or swapped. Some cases also sell the charm separately as a variant.</p>
<h3>What is the "Case+Grip+Charm" variant?</h3>
<p>This bundle includes the case, a MagSafe-compatible pop grip, and a character charm. You can also purchase just the case, or the case with only the grip or charm — select your preferred combination from the variant selector on the product page.</p>
<h2>Returns &amp; Refunds</h2>
<h3>What is your return policy?</h3>
<p>We accept returns within 30 days of delivery for unused items in original condition. See our <a href="/policies/refund-policy">Refund Policy</a> for full details.</p>
<h3>My item arrived damaged — what do I do?</h3>
<p>We're sorry to hear that! Please email us at <a href="mailto:hello@y2kase.com">hello@y2kase.com</a> within 7 days of delivery with photos of the damage and your order number. We'll arrange a replacement promptly.</p>
<h2>Still have questions?</h2>
<p>Contact us at <a href="mailto:hello@y2kase.com">hello@y2kase.com</a> — we respond within 24 hours.</p>`,
  },
];

console.log('\n══ STEP 2: PAGES ════════════════════════════════════════════');
const existingPages = await rest('GET', '/pages.json?limit=250&fields=handle');
const existingHandles = new Set((existingPages.pages || []).map(p => p.handle));

for (const page of PAGES) {
  if (existingHandles.has(page.handle)) {
    console.log(`  ⏭  Skip (exists): ${page.title}`);
    continue;
  }
  if (DRY) { console.log(`  [DRY] Would create page: "${page.title}" (/${page.handle})`); continue; }
  const result = await rest('POST', '/pages.json', { page });
  if (result.page) console.log(`  ✅ Created: "${result.page.title}" — ${SHOP}/pages/${result.page.handle}`);
  else console.error(`  ❌ Error:`, result.errors || result);
}

// ══════════════════════════════════════════════════════════════════════════════
// STEP 3: NAVIGATION MENUS
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n══ STEP 3: NAVIGATION MENUS ═════════════════════════════════');

// Fetch collection IDs for menu links
const colsRes = await rest('GET', '/smart_collections.json?limit=250&fields=id,handle,title');
const allColsRes = await rest('GET', '/custom_collections.json?limit=250&fields=id,handle,title');
const allCols = [...(colsRes.smart_collections||[]), ...(allColsRes.custom_collections||[])];
const colByHandle = Object.fromEntries(allCols.map(c => [c.handle, c]));

const getColUrl = (handle) => {
  const col = colByHandle[handle];
  return col ? `/collections/${handle}` : `/collections/${handle}`;
};

const MAIN_MENU = {
  title: 'Main Menu',
  handle: 'main-menu',
  items: [
    { title: 'All Cases', url: getColUrl('iphone-cases') },
    { title: 'MagSafe', url: getColUrl('magsafe') },
    {
      title: 'Sanrio',
      url: getColUrl('sanrio'),
      items: [
        { title: 'Hello Kitty', url: getColUrl('hello-kitty') },
        { title: 'My Melody', url: getColUrl('my-melody') },
        { title: 'Cinnamoroll', url: getColUrl('cinnamoroll') },
        { title: 'Kuromi', url: getColUrl('kuromi') },
      ],
    },
    {
      title: 'Disney',
      url: getColUrl('disney'),
      items: [
        { title: 'Winnie the Pooh', url: getColUrl('winnie-the-pooh') },
        { title: 'Zootopia', url: getColUrl('zootopia') },
      ],
    },
    {
      title: 'Anime',
      url: getColUrl('anime'),
      items: [
        { title: 'Chiikawa', url: getColUrl('chiikawa') },
        { title: 'Hatsune Miku', url: getColUrl('hatsune-miku') },
      ],
    },
    {
      title: 'Aesthetic',
      url: getColUrl('kawaii'),
      items: [
        { title: 'Kawaii', url: getColUrl('kawaii') },
        { title: 'Coquette', url: getColUrl('coquette') },
        { title: 'Y2K & Gyaru', url: getColUrl('y2k') },
        { title: 'Dark Cute', url: getColUrl('dark-cute') },
      ],
    },
  ],
};

const FOOTER_MENU = {
  title: 'Footer Menu',
  handle: 'footer',
  items: [
    { title: 'About', url: '/pages/about' },
    { title: 'FAQ', url: '/pages/faq' },
    { title: 'Contact', url: '/pages/contact' },
    { title: 'Shipping Policy', url: '/policies/shipping-policy' },
    { title: 'Refund Policy', url: '/policies/refund-policy' },
    { title: 'Privacy Policy', url: '/policies/privacy-policy' },
    { title: 'Terms of Service', url: '/policies/terms-of-service' },
  ],
};

// Helper: flatten nested items for GraphQL input
function flattenMenuItems(items, parentId = null) {
  const result = [];
  for (const item of items) {
    result.push({ title: item.title, url: item.url, type: 'HTTP' });
  }
  return result;
}

for (const menu of [MAIN_MENU, FOOTER_MENU]) {
  if (DRY) {
    console.log(`  [DRY] Would create menu: "${menu.title}" (${menu.handle}) with ${menu.items.length} items`);
    continue;
  }

  // Check if exists
  const existingMenus = await gql(`{ menus(first:50){ nodes{ handle } } }`);
  const exists = existingMenus.data?.menus?.nodes?.some(m => m.handle === menu.handle);
  if (exists) { console.log(`  ⏭  Skip (exists): "${menu.title}"`); continue; }

  // Build items for GraphQL — menuCreate supports nested items
  const buildItems = (items) => items.map(item => ({
    title: item.title,
    url: `https://${SHOP}${item.url}`,
    type: 'HTTP',
    ...(item.items ? { items: buildItems(item.items) } : {}),
  }));

  const result = await gql(`
    mutation menuCreate($title: String!, $handle: String!, $items: [MenuItemCreateInput!]!) {
      menuCreate(title: $title, handle: $handle, items: $items) {
        menu { id title handle }
        userErrors { field message }
      }
    }
  `, { title: menu.title, handle: menu.handle, items: buildItems(menu.items) });

  const errs = result.data?.menuCreate?.userErrors;
  if (errs?.length) console.error(`  ❌ Error creating "${menu.title}":`, JSON.stringify(errs));
  else if (result.errors) console.error(`  ❌ GraphQL error:`, JSON.stringify(result.errors));
  else console.log(`  ✅ Created: "${result.data?.menuCreate?.menu?.title}" (${result.data?.menuCreate?.menu?.handle})`);
}

// ══════════════════════════════════════════════════════════════════════════════
// STEP 4: SEO PRODUCT TITLE REWRITE
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n══ STEP 4: SEO TITLE REWRITE ═════════════════════════════════');
console.log('  Strategy: [Character] [Style] iPhone Case – [Key Descriptor]');
console.log('  Target: 50–70 chars · Human-readable · Google-optimised\n');

// Map existing titles to SEO-optimised versions
// Format: Character + Case Type + Key Feature (≤ 70 chars)
const TITLE_MAP = [
  { id: 7701460090957, newTitle: 'Cinnamoroll Liquid Glitter iPhone Case with Shaker Grip' },       // 55
  { id: 7701459107917, newTitle: 'Chiikawa MagSafe iPhone Case – Glitter Anime Grip & Charm' },    // 58
  { id: 7701458911309, newTitle: 'Cinnamoroll Angel MagSafe Case – Blue Gingham Coquette' },       // 54
  { id: 7701459009613, newTitle: 'Cinnamoroll MagSafe iPhone Case – Blue Gingham & Pearl Charm' }, // 60
  { id: 7701458845773, newTitle: 'Hello Kitty Liquid Glitter iPhone Case – Christmas Snow' },      // 54
  { id: 7701461205069, newTitle: 'Hello Kitty Wallet iPhone Case – Christmas Card Holder' },       // 53
  { id: 7701461991501, newTitle: 'Hello Kitty Embroidery iPhone Case – Coquette Lace Charm' },    // 56
  { id: 7701458944077, newTitle: 'Hello Kitty Kitchen MagSafe Case – Red Gingham Shaker' },       // 54
  { id: 7701458878541, newTitle: 'Hello Kitty MagSafe iPhone Case – Coffee Shaker Grip & Charm' },// 60
  { id: 7701461401677, newTitle: 'Hello Kitty & My Melody Leather Case – Plush Bow Charm' },      // 55
  { id: 7701461172301, newTitle: 'Hello Kitty My Melody iPhone Case – Y2K Winter Ski Charm' },    // 58
  { id: 7701461270605, newTitle: 'Hello Kitty Leather iPhone Case – Hand Strap & Flower Stand' }, // 60
  { id: 7701462057037, newTitle: 'Hello Kitty Sanrio Case – My Melody Kuromi Cinnamoroll 3D' },   // 57
  { id: 7701461008461, newTitle: 'Judy Hopps Zootopia MagSafe Case – Shaker Grip & Charm' },      // 55
  { id: 7701459370061, newTitle: 'Hello Kitty Friends Holographic iPhone Case – Sanrio Kawaii' }, // 60
  { id: 7701462122573, newTitle: 'Kuromi Glitter iPhone Case – Jirai Kei Dark Cute 3D Grip' },    // 57
  { id: 7701461860429, newTitle: 'Hello Kitty Leopard iPhone Case – Y2K Gyaru Shaker Grip' },     // 55
  { id: 7701461303373, newTitle: 'My Melody Baking Leather iPhone Case – Kawaii Chef Charm' },    // 57
  { id: 7701458813005, newTitle: 'My Melody Liquid Glitter iPhone Case – Pink Strawberry Charm' },// 60
  { id: 7701461237837, newTitle: 'My Melody Wallet iPhone Case – Sweet Piano Card Holder' },      // 54
  { id: 7701461073997, newTitle: 'My Sweet Piano iPhone Case – Coquette Kawaii 3D Grip Charm' },  // 58
  { id: 7701460942925, newTitle: 'Hatsune Miku iPhone Case – Kawaii Vocaloid 3D Grip & Charm' },  // 58
  { id: 7701461041229, newTitle: 'Hello Kitty Quilted iPhone Case – 3D Bow Coquette Leather' },   // 57
  { id: 7701460746317, newTitle: 'My Melody Glitter iPhone Case – Coquette Bow Grip & Charm' },   // 57
  { id: 7701460418637, newTitle: 'My Melody MagSafe iPhone Case – Sleeping Bunny Kawaii Grip' },  // 58
  { id: 7701460451405, newTitle: 'My Melody MagSafe Case – Sweet Piano Ring Stand & Charm' },     // 54
  { id: 7701460385869, newTitle: 'Kuromi MagSafe iPhone Case – Lavender Kawaii Grip & Charm' },   // 57
  { id: 7701461106765, newTitle: 'Winnie the Pooh MagSafe Case – Autumn Kawaii Shaker Charm' },   // 57
  { id: 7701459238989, newTitle: 'Zootopia Judy Hopps MagSafe Case – 3D Shaker Grip & Stand' },   // 57
];

// Validate lengths
const titleIssues = TITLE_MAP.filter(t => t.newTitle.length > 70);
if (titleIssues.length) {
  console.log('  ⚠️  Titles still over 70 chars:');
  titleIssues.forEach(t => console.log(`    [${t.newTitle.length}] ${t.newTitle}`));
}

let titleUpdated = 0, titleErrors = 0;
for (const { id, newTitle } of TITLE_MAP) {
  if (DRY) {
    console.log(`  [DRY] ${newTitle.length} chars: ${newTitle}`);
    continue;
  }
  const result = await rest('PUT', `/products/${id}.json`, { product: { id, title: newTitle } });
  if (result.product) {
    console.log(`  ✅ [${newTitle.length}c] ${newTitle}`);
    titleUpdated++;
  } else {
    console.error(`  ❌ ID ${id}:`, result.errors || result);
    titleErrors++;
  }
}

if (!DRY) console.log(`\n  Titles: ${titleUpdated} updated, ${titleErrors} errors`);

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n══ COMPLETE ═════════════════════════════════════════════════');
if (DRY) {
  console.log('\n  DRY RUN complete. Run with --apply to execute all changes.\n');
} else {
  console.log(`
  Done. Verify at:
  Store:      https://${SHOP}
  Collections: https://${SHOP}/admin/collections
  Pages:       https://${SHOP}/admin/pages
  Navigation:  https://${SHOP}/admin/menus
  Policies:    https://${SHOP}/admin/settings/legal
`);
}
