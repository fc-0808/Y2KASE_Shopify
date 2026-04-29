/**
 * Y2KASE Comprehensive Store Audit
 * Pulls every relevant dimension of store health in parallel
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
const GQL     = `${BASE}/graphql.json`;

const rest = async (path) => {
  const r = await fetch(`${BASE}${path}`, { headers: { 'X-Shopify-Access-Token': TOKEN } });
  return r.json();
};
const gql = async (query) => {
  const r = await fetch(GQL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN }, body: JSON.stringify({ query }) });
  return r.json();
};

const [
  productsRes, smartCols, customCols, pages,
  shopRes, themes, menusRes, policiesRes
] = await Promise.all([
  rest('/products.json?limit=250&fields=id,title,handle,product_type,tags,images,variants,status,metafields,body_html'),
  rest('/smart_collections.json?limit=250'),
  rest('/custom_collections.json?limit=250'),
  rest('/pages.json?limit=250'),
  rest('/shop.json'),
  rest('/themes.json'),
  gql(`{ menus(first:10){ nodes{ title handle items{ title url type } } } }`),
  rest('/policies.json'),
]);

const products   = productsRes.products  || [];
const shop       = shopRes.shop          || {};
const allCols    = [...(smartCols.smart_collections||[]), ...(customCols.custom_collections||[])];
const menus      = menusRes.data?.menus?.nodes || [];
const pagesArr   = pages.pages           || [];
const policiesArr= policiesRes.policies  || [];
const activeTheme= (themes.themes||[]).find(t=>t.role==='main');

// ── Product SEO audit ──────────────────────────────────────────────────────
const seoIssues = [];
for (const p of products) {
  const issues = [];
  if (p.title.length > 70)   issues.push(`title ${p.title.length} chars (>70)`);
  if (!p.product_type)       issues.push('no product_type');
  if (!p.body_html || p.body_html.replace(/<[^>]+>/g,'').trim().length < 100)
                              issues.push('thin description (<100 chars)');
  if ((p.images||[]).length < 3) issues.push(`only ${(p.images||[]).length} images`);
  if (issues.length) seoIssues.push({ title: p.title.slice(0,55), issues });
}

// ── Tag taxonomy check ─────────────────────────────────────────────────────
const taxonomyPrefixes = ['type:', 'device:', 'attach:', 'char:', 'ip:', 'style:', 'aesthetic:', 'feature:'];
const taxonomyIssues = products.filter(p => {
  const tags = (p.tags||'').split(',').map(t=>t.trim());
  return !taxonomyPrefixes.some(pf => tags.some(t => t.startsWith(pf)));
});

// ── Collection health ──────────────────────────────────────────────────────
const emptyPublicCols = allCols.filter(c => c.published_at && (c.products_count||0) === 0);

// ── Page check ────────────────────────────────────────────────────────────
// Policies live at /policies/* not /pages/* — only check actual custom pages
const requiredPages = ['about', 'faq', 'contact'];
const pageHandles   = pagesArr.map(p=>p.handle.toLowerCase());
const missingPages  = requiredPages.filter(r => !pageHandles.some(h=>h.includes(r)));

// ── Policy check ──────────────────────────────────────────────────────────
// Use the actual policy body check (REST returns id as null but body exists)
const requiredPolicies = ['refund_policy','shipping_policy','privacy_policy','terms_of_service'];
const policyMap = {}; // verified separately via verify-policies.mjs

// ── Menu check ────────────────────────────────────────────────────────────
const hasMainMenu   = menus.some(m=>m.handle==='main-menu'||m.handle==='header');
const hasFooterMenu = menus.some(m=>m.handle==='footer'||m.handle==='footer-menu');

console.log(JSON.stringify({
  timestamp: new Date().toISOString(),
  store: { name: shop.name, domain: shop.domain, plan: shop.plan_display_name, email: shop.email, currency: shop.currency },
  theme: { name: activeTheme?.name, id: activeTheme?.id, role: activeTheme?.role },
  products: { total: products.length, withProductType: products.filter(p=>p.product_type).length, withTaxonomyTags: products.length - taxonomyIssues.length, seoIssueCount: seoIssues.length },
  collections: { total: allCols.length, smart: smartCols.smart_collections?.length, custom: customCols.custom_collections?.length, emptyPublic: emptyPublicCols.map(c=>c.title) },
  pages: { total: pagesArr.length, handles: pagesArr.map(p=>p.handle), missing: missingPages },
  policies: { total: policiesArr.length, handles: policiesArr.map(p=>p.id) },
  navigation: { hasMainMenu, hasFooterMenu, menuCount: menus.length, menus: menus.map(m=>({title:m.title,handle:m.handle,items:m.items?.length})) },
  seoIssues,
  criticalIssues: {
    noNavigation: !hasMainMenu,
    missingPages,
    missingPolicies: policiesArr.filter(p=>p.body?.replace(/<[^>]+>/g,'').trim().length < 50).map(p=>p.title),
    productsWithoutType: products.filter(p=>!p.product_type).length,
    productsWithLongTitles: products.filter(p=>p.title.length>70).length,
  }
}, null, 2));
