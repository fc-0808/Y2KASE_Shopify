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
const VER   = process.env.SHOPIFY_API_VERSION || '2026-04';

const gql = async (query) => {
  const r = await fetch(`https://${SHOP}/admin/api/${VER}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return r.json();
};

// Check first product's variant availability via GraphQL
const productQuery = `{
  product(id: "gid://shopify/Product/7701459107917") {
    title
    status
    variants(first: 3) {
      edges { node {
        id
        title
        availableForSale
        inventoryPolicy
        inventoryItem {
          tracked
          inventoryLevels(first: 5) {
            edges { node {
              quantities(names: ["available"]) { name quantity }
            }}
          }
        }
      }}
    }
  }
}`;

console.log('=== GraphQL Product + Inventory Check ===');
const res = await gql(productQuery);
if (res.errors) {
  console.error('GraphQL errors:', JSON.stringify(res.errors, null, 2));
} else {
  const p = res.data.product;
  console.log('Title:', p.title);
  console.log('Status:', p.status);
  console.log('\nVariants:');
  p.variants.edges.forEach(e => {
    const v = e.node;
    console.log(' ', v.title);
    console.log('  availableForSale:', v.availableForSale, '| inventoryPolicy:', v.inventoryPolicy);
    console.log('  inventoryItem.tracked:', v.inventoryItem.tracked);
    v.inventoryItem.inventoryLevels.edges.forEach(ie => {
      const loc = ie.node.location;
      const qty = ie.node.quantities?.[0]?.quantity ?? 'n/a';
    console.log('  inventory level available qty:', qty);
    });
  });
}

// Check all markets catalog inclusions
console.log('\n=== Markets ===');
const marketsQuery = `{
  markets(first: 10) {
    edges { node {
      id name enabled
      regions(first: 5) { edges { node { ... on MarketRegionCountry { code name } } } }
    }}
  }
}`;
const marketsRes = await gql(marketsQuery);
if (marketsRes.errors) {
  console.error('Markets errors:', JSON.stringify(marketsRes.errors, null, 2));
} else {
  marketsRes.data.markets.edges.forEach(e => {
    const m = e.node;
    const regions = m.regions.edges.map(r => r.node.code || r.node.name).join(', ');
    console.log(' ', m.name, '| enabled:', m.enabled);
  });
}
