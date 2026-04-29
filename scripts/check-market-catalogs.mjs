import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
function loadEnv(f) {
  let t = readFileSync(f, 'utf8'); if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  for (const line of t.split(/\r?\n/)) { const s = line.trim(); if (!s || s.startsWith('#')) continue; const eq = s.indexOf('='); if (eq === -1) continue; process.env[s.slice(0, eq).trim()] = s.slice(eq + 1).trim(); }
}
loadEnv(resolve(__dirname, '../.env'));

const SHOP  = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const VER   = process.env.SHOPIFY_API_VERSION || '2025-04';

const gql = async (query, vars = {}) => {
  const r = await fetch(`https://${SHOP}/admin/api/${VER}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: vars }),
  });
  return r.json();
};

// Check catalogs and their publication status
console.log('=== Catalogs ===');
const catalogsRes = await gql(`{
  catalogs(first: 20) {
    edges { node {
      id
      title
      status
      ... on MarketCatalog {
        markets(first: 5) { edges { node { id name enabled } } }
      }
      priceList { id name }
    }}
  }
}`);

if (catalogsRes.errors) {
  console.log('Catalog errors:', JSON.stringify(catalogsRes.errors.map(e => e.message)));
} else {
  const catalogs = catalogsRes.data?.catalogs?.edges || [];
  if (catalogs.length === 0) {
    console.log('  (no catalogs found)');
  } else {
    catalogs.forEach(e => {
      const c = e.node;
      console.log(' ', c.id, c.title, '| status:', c.status);
      if (c.markets?.edges?.length > 0) {
        c.markets.edges.forEach(me => console.log('   market:', me.node.name, '| enabled:', me.node.enabled));
      }
      if (c.priceList) console.log('   priceList:', c.priceList.name);
    });
  }
}

// Check publications (sales channels)
console.log('\n=== Publications / Sales Channels ===');
const pubsRes = await gql(`{
  publications(first: 10) {
    edges { node {
      id
      name
      catalog { id ... on MarketCatalog { markets(first: 5) { edges { node { name } } } } }
    }}
  }
}`);

if (pubsRes.errors) {
  console.log('Publications errors:', JSON.stringify(pubsRes.errors.map(e => e.message)));
} else {
  (pubsRes.data?.publications?.edges || []).forEach(e => {
    const pub = e.node;
    console.log(' ', pub.id, pub.name);
  });
}

// Check if first product is in all publications
console.log('\n=== Product Publication Status ===');
const productPubRes = await gql(`{
  product(id: "gid://shopify/Product/7701459107917") {
    title
    status
    variants(first: 1) {
      edges { node {
        id
        availableForSale
        sellableOnlineQuantity
      }}
    }
  }
}`);

if (productPubRes.errors) {
  console.log('Errors:', JSON.stringify(productPubRes.errors.map(e => e.message)));
} else {
  const p = productPubRes.data?.product;
  console.log('Product:', p.title, '| status:', p.status);
  p.variants.edges.forEach(e => {
    const v = e.node;
    console.log('  Variant:', v.id, '| availableForSale:', v.availableForSale, '| sellableOnlineQuantity:', v.sellableOnlineQuantity);
  });
}
