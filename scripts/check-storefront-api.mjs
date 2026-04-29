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
const VER   = process.env.SHOPIFY_API_VERSION || '2025-04';

// Try unauthenticated Storefront API call
const sfQuery = `{
  product(handle: "chiikawa-magsafe-case-iphone-17-16-15-14-96054") {
    title
    availableForSale
    variants(first: 5) {
      edges { node {
        id
        title
        availableForSale
        currentlyNotInStock
      }}
    }
  }
}`;

console.log('=== Unauthenticated Storefront API ===');
const r1 = await fetch(`https://${SHOP}/api/${VER}/graphql.json`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sfQuery }),
});
const d1 = await r1.json();
console.log('Status:', r1.status);
if (d1.errors) {
  console.log('Errors:', d1.errors.map(e => e.message).join('\n'));
} else {
  const p = d1.data?.product;
  if (p) {
    console.log('Product:', p.title, '| availableForSale:', p.availableForSale);
    p.variants.edges.forEach(e => {
      const v = e.node;
      console.log(' ', v.title, '| availableForSale:', v.availableForSale,
        '| currentlyNotInStock:', v.currentlyNotInStock);
    });
  } else {
    console.log('Raw response:', JSON.stringify(d1).slice(0, 300));
  }
}
