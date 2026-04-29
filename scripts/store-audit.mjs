/**
 * Full store audit: products detail, collections, pages, navigation, SEO
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../.env');

function loadEnv(filePath) {
  let text = readFileSync(filePath, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    process.env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
}

loadEnv(envPath);

const SHOP    = process.env.SHOPIFY_SHOP;
const TOKEN   = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const VERSION = process.env.SHOPIFY_API_VERSION || '2025-04';
const BASE    = `https://${SHOP}/admin/api/${VERSION}`;
const GQL_URL = `${BASE}/graphql.json`;

async function rest(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' }
  });
  return res.json();
}

async function gql(query) {
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query }),
  });
  return res.json();
}

const [collectionsRes, pagesRes, productsDetail, shopRes, navigationRes] = await Promise.all([
  rest('/collections.json?limit=50'),
  rest('/pages.json?limit=50'),
  rest('/products.json?limit=50&fields=id,title,handle,body_html,images,variants,tags,product_type,metafields'),
  rest('/shop.json'),
  gql(`{
    menus(first: 10) {
      nodes { title handle items { title url } }
    }
  }`)
]);

const shop = shopRes.shop;
const products = productsDetail.products;
const collections = collectionsRes.collections;
const pages = pagesRes.pages;

console.log('\n╔══════════════════════════════════════════════════════════╗');
console.log('║              Y2KASE FULL STORE AUDIT                    ║');
console.log('╚══════════════════════════════════════════════════════════╝');

// === STORE INFO ===
console.log('\n── STORE INFO ──────────────────────────────────────────────');
console.log(`Domain:     ${shop?.domain} → ${shop?.myshopify_domain}`);
console.log(`Plan:       ${shop?.plan_display_name}`);
console.log(`Currency:   ${shop?.currency}`);
console.log(`Email:      ${shop?.email}`);
console.log(`Phone:      ${shop?.phone || 'NOT SET'}`);
console.log(`Country:    ${shop?.country_name}`);
console.log(`Timezone:   ${shop?.iana_timezone}`);

// === COLLECTIONS ===
console.log('\n── COLLECTIONS ─────────────────────────────────────────────');
if (!collections?.length) {
  console.log('⚠️  NO COLLECTIONS FOUND — products are not organized');
} else {
  for (const c of collections) {
    console.log(`  • ${c.title} (/${c.handle}) — ${c.products_count ?? '?'} products`);
  }
}

// === PAGES ===
console.log('\n── PAGES ───────────────────────────────────────────────────');
if (!pages?.length) {
  console.log('⚠️  NO CUSTOM PAGES — missing About, FAQ, Contact, Policies');
} else {
  for (const p of pages) {
    const hasContent = p.body_html && p.body_html.replace(/<[^>]+>/g, '').trim().length > 0;
    console.log(`  ${hasContent ? '✅' : '⚠️ empty'} ${p.title} (/${p.handle})`);
  }
}

// === NAVIGATION ===
console.log('\n── NAVIGATION ──────────────────────────────────────────────');
const menus = navigationRes.data?.menus?.nodes;
if (!menus?.length) {
  console.log('⚠️  No navigation menus found');
} else {
  for (const m of menus) {
    console.log(`  Menu: "${m.title}" (${m.handle})`);
    for (const item of m.items) {
      console.log(`    → ${item.title}: ${item.url}`);
    }
  }
}

// === PRODUCT SEO AUDIT ===
console.log('\n── PRODUCT SEO & CONTENT AUDIT ─────────────────────────────');
let missingDesc = 0, longTitles = 0, noImages = 0, noTags = 0, missingType = 0;

for (const p of products) {
  const titleLen = p.title.length;
  const hasDesc = p.body_html && p.body_html.replace(/<[^>]+>/g, '').trim().length > 50;
  const imgCount = p.images?.length ?? 0;
  const tagCount = p.tags?.split(',').filter(Boolean).length ?? 0;

  if (titleLen > 70) longTitles++;
  if (!hasDesc) missingDesc++;
  if (imgCount === 0) noImages++;
  if (tagCount === 0) noTags++;
  if (!p.product_type) missingType++;
}

console.log(`  Total products: ${products.length}`);
console.log(`  ${longTitles > 0 ? '⚠️' : '✅'} Titles >70 chars (bad for Google): ${longTitles}/${products.length}`);
console.log(`  ${missingDesc > 0 ? '⚠️' : '✅'} Missing/thin descriptions: ${missingDesc}/${products.length}`);
console.log(`  ${noImages > 0 ? '⚠️' : '✅'} No product images: ${noImages}/${products.length}`);
console.log(`  ${noTags > 0 ? '⚠️' : '✅'} No tags: ${noTags}/${products.length}`);
console.log(`  ${missingType > 0 ? '⚠️' : '✅'} Missing product type: ${missingType}/${products.length}`);

// === PRICING ===
console.log('\n── PRICING ANALYSIS ────────────────────────────────────────');
const prices = products.flatMap(p => p.variants.map(v => parseFloat(v.price)));
const min = Math.min(...prices), max = Math.max(...prices);
const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
console.log(`  Price range: HK$${min.toFixed(2)} – HK$${max.toFixed(2)}`);
console.log(`  Average:     HK$${avg.toFixed(2)} (~US$${(avg/7.8).toFixed(2)})`);
const totalStock = products.reduce((s, p) => s + p.variants.reduce((vs, v) => vs + (v.inventory_quantity || 0), 0), 0);
console.log(`  Total stock: ${totalStock} units`);

// === VARIANTS (phone models) ===
console.log('\n── VARIANT / PHONE MODEL COVERAGE ─────────────────────────');
const allVariantTitles = new Set(products.flatMap(p => p.variants.map(v => v.title)));
console.log(`  Unique variants: ${allVariantTitles.size}`);
const sample = [...allVariantTitles].slice(0, 10);
console.log(`  Sample: ${sample.join(', ')}`);

// === SAMPLE TITLE LENGTHS ===
console.log('\n── TITLE LENGTH SAMPLE (top 5 longest) ────────────────────');
const sorted = [...products].sort((a, b) => b.title.length - a.title.length).slice(0, 5);
for (const p of sorted) {
  console.log(`  [${p.title.length} chars] ${p.title.slice(0, 80)}...`);
}
