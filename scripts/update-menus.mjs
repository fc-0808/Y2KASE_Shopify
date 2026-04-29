/**
 * Update existing Shopify navigation menus with full Y2KASE structure
 * Uses menuUpdate mutation since menus already exist
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
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
loadEnv(resolve(__dirname, '../.env'));

const SHOP    = process.env.SHOPIFY_SHOP;
const TOKEN   = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const VERSION = process.env.SHOPIFY_API_VERSION || '2025-04';
const GQL     = `https://${SHOP}/admin/api/${VERSION}/graphql.json`;
const sleep   = (ms) => new Promise(r => setTimeout(r, ms));

const gql = async (query, variables = {}) => {
  const r = await fetch(GQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  await sleep(400);
  return r.json();
};

// ── Fetch all existing menus with their IDs ───────────────────────────────

const menusRes = await gql(`{
  menus(first: 20) {
    nodes {
      id
      title
      handle
      items {
        id
        title
        url
        items {
          id
          title
          url
        }
      }
    }
  }
}`);

const menus = menusRes.data?.menus?.nodes || [];
console.log('Existing menus:');
menus.forEach(m => console.log(`  ${m.handle} (${m.id}) — ${m.items.length} items`));

const mainMenu   = menus.find(m => m.handle === 'main-menu');
const footerMenu = menus.find(m => m.handle === 'footer');

if (!mainMenu)   { console.error('Main menu not found!'); }
if (!footerMenu) { console.error('Footer menu not found!'); }

const shop = SHOP;

// ── Build menu item input ─────────────────────────────────────────────────

const item = (title, url, children) => ({
  title,
  url: url.startsWith('http') ? url : `https://${shop}${url}`,
  type: 'HTTP',
  ...(children ? { items: children } : {}),
});

const MAIN_ITEMS = [
  item('All Cases',   '/collections/iphone-cases'),
  item('MagSafe',     '/collections/magsafe'),
  item('Sanrio',      '/collections/sanrio', [
    item('Hello Kitty',  '/collections/hello-kitty'),
    item('My Melody',    '/collections/my-melody'),
    item('Cinnamoroll',  '/collections/cinnamoroll'),
    item('Kuromi',       '/collections/kuromi'),
  ]),
  item('Disney',      '/collections/disney', [
    item('Winnie the Pooh', '/collections/winnie-the-pooh'),
    item('Zootopia',        '/collections/zootopia'),
  ]),
  item('Anime',       '/collections/anime', [
    item('Chiikawa',      '/collections/chiikawa'),
    item('Hatsune Miku',  '/collections/hatsune-miku'),
  ]),
  item('Aesthetic',   '/collections/kawaii', [
    item('Kawaii',      '/collections/kawaii'),
    item('Coquette',    '/collections/coquette'),
    item('Y2K',         '/collections/y2k'),
    item('Dark Cute',   '/collections/dark-cute'),
  ]),
];

const FOOTER_ITEMS = [
  item('About',           '/pages/about'),
  item('FAQ',             '/pages/faq'),
  item('Contact',         '/pages/contact'),
  item('Shipping Policy', '/policies/shipping-policy'),
  item('Refund Policy',   '/policies/refund-policy'),
  item('Privacy Policy',  '/policies/privacy-policy'),
  item('Terms of Service','/policies/terms-of-service'),
];

// ── Update menus ──────────────────────────────────────────────────────────

for (const [menu, items, label] of [
  [mainMenu,   MAIN_ITEMS,   'Main Menu'],
  [footerMenu, FOOTER_ITEMS, 'Footer Menu'],
]) {
  if (!menu) continue;

  const result = await gql(`
    mutation menuUpdate($id: ID!, $title: String!, $items: [MenuItemUpdateInput!]!) {
      menuUpdate(id: $id, title: $title, items: $items) {
        menu {
          id
          title
          handle
          items {
            title
            url
            items { title url }
          }
        }
        userErrors { field message }
      }
    }
  `, { id: menu.id, title: menu.title, items });

  const errs = result.data?.menuUpdate?.userErrors;
  if (errs?.length) {
    console.error(`❌ ${label}:`, JSON.stringify(errs));
  } else if (result.errors) {
    console.error(`❌ ${label} GraphQL error:`, JSON.stringify(result.errors));
  } else {
    const updated = result.data?.menuUpdate?.menu;
    console.log(`\n✅ ${label} updated — ${updated?.items?.length} top-level items:`);
    updated?.items?.forEach(i => {
      console.log(`  → ${i.title}: ${i.url}`);
      i.items?.forEach(sub => console.log(`      ↳ ${sub.title}: ${sub.url}`));
    });
  }
}

// ── Verify policies ───────────────────────────────────────────────────────

console.log('\n══ POLICY VERIFICATION ════════════════════════════════');
const policiesRes = await gql(`{
  shop {
    refundPolicy { title url body }
    shippingPolicy { title url body }
    privacyPolicy { title url body }
    termsOfService { title url body }
  }
}`);

const s = policiesRes.data?.shop;
for (const [name, policy] of [
  ['Refund Policy',    s?.refundPolicy],
  ['Shipping Policy',  s?.shippingPolicy],
  ['Privacy Policy',   s?.privacyPolicy],
  ['Terms of Service', s?.termsOfService],
]) {
  if (policy?.body?.length > 100) {
    console.log(`  ✅ ${name}: ${policy.body.length} chars — ${policy.url}`);
  } else {
    console.log(`  ❌ ${name}: NOT set or empty`);
  }
}
