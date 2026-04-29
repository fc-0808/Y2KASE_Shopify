import { shopifyFetch } from './shopify-client.mjs';

const data = await shopifyFetch('/products.json?limit=50&fields=id,title,status,variants,images');

console.log(`\n📦  Y2KASE Products (${data.products.length} found)\n`);
console.log('─'.repeat(60));

for (const p of data.products) {
  const price = p.variants?.[0]?.price ?? '—';
  const stock = p.variants?.reduce((sum, v) => sum + (v.inventory_quantity ?? 0), 0);
  const status = p.status === 'active' ? '🟢' : '🔴';
  console.log(`${status}  ${p.title}`);
  console.log(`    ID: ${p.id}  |  Price: HK$${price}  |  Stock: ${stock}`);
}

console.log('─'.repeat(60));
