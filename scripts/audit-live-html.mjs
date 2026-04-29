const r = await fetch('https://y2kase.com/collections/all', {
  headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
});
const html = await r.text();

// Find all product-card elements and check what badge they show
const cardMatches = [...html.matchAll(/data-product-id="(\d+)"[\s\S]{0,2000}?product-badges[\s\S]{0,500}?<\/div>/g)];
console.log('Product card badge samples:', cardMatches.length);

// More targeted: find each product badge section
const badgeSections = [...html.matchAll(/class="product-badges[\s\S]{0,400}?<\/div>\s*<\/div>/g)];
console.log('\nTotal badge sections found:', badgeSections.length);
badgeSections.slice(0, 5).forEach((m, i) => {
  const text = m[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  console.log(`  Badge ${i + 1}: ${text}`);
});

// Count sold out vs sale badge texts specifically
const soldOutBadges = [...html.matchAll(/product-badges__badge[^>]*>[\s\n]*([^<\n]{1,30})/g)]
  .map(m => m[1].trim())
  .filter(t => t.length > 0);

console.log('\nAll badge texts found:', soldOutBadges.length);
const freq = {};
soldOutBadges.forEach(t => { freq[t] = (freq[t] || 0) + 1; });
Object.entries(freq).sort((a,b)=>b[1]-a[1]).forEach(([t,c]) => console.log(`  "${t}": ${c} times`));

// Count distinct products in HTML
const productIds = [...html.matchAll(/data-product-id="(\d+)"/g)].map(m => m[1]);
const uniqueProductIds = [...new Set(productIds)];
console.log('\nUnique product IDs in HTML:', uniqueProductIds.length);
console.log('Product IDs:', uniqueProductIds.join(', '));
