// Uses GraphQL Admin API (2026-04) — replaces deprecated REST GET /products.json
import { shopifyGql } from './shopify-client.mjs';

const result = await shopifyGql(`
  query {
    products(first: 50) {
      edges {
        node {
          id
          title
          status
          variants(first: 1) {
            edges { node { price } }
          }
          media(first: 1) {
            edges { node { id } }
          }
          totalInventory
        }
      }
    }
  }
`);

const products = result.data?.products?.edges?.map(e => e.node) ?? [];

console.log(`\n📦  Y2KASE Products (${products.length} found)\n`);
console.log('─'.repeat(60));

for (const p of products) {
  const price  = p.variants?.edges?.[0]?.node?.price ?? '—';
  const stock  = p.totalInventory ?? 0;
  const status = p.status === 'ACTIVE' ? '🟢' : '🔴';
  console.log(`${status}  ${p.title}`);
  console.log(`    GID: ${p.id}  |  Price: HK$${price}  |  Stock: ${stock}`);
}

console.log('─'.repeat(60));
