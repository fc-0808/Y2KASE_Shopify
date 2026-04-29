import { shopifyFetch } from './shopify-client.mjs';

const data = await shopifyFetch(
  '/orders.json?status=any&limit=50&fields=id,name,email,financial_status,fulfillment_status,total_price,created_at'
);

console.log(`\n🛒  Y2KASE Orders (${data.orders.length} found)\n`);
console.log('─'.repeat(70));

for (const o of data.orders) {
  const date = new Date(o.created_at).toLocaleDateString('en-HK');
  const fin  = o.financial_status?.padEnd(10) ?? '—';
  const ful  = o.fulfillment_status ?? 'unfulfilled';
  console.log(`${o.name}  |  ${date}  |  HK$${o.total_price}  |  ${fin}  |  ${ful}`);
  if (o.email) console.log(`    📧  ${o.email}`);
}

console.log('─'.repeat(70));
