const r = await fetch('https://y2kase.com/collections/all', {
  headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
});
const html = await r.text();

const soldOutCount = (html.match(/sold.out/gi) || []).length;
const saleCount    = (html.match(/badge.sale|Sale badge/gi) || []).length;
const addToCart    = (html.match(/add.to.cart/gi) || []).length;
const badgeHits    = [...html.matchAll(/product-badges__badge[^>]*>([^<]{1,30})</g)].map(m => m[1].trim()).filter(Boolean);

console.log('Page status:', r.status);
console.log('"sold out" occurrences:', soldOutCount);
console.log('"sale" badge occurrences:', saleCount);
console.log('"add to cart" occurrences:', addToCart);
console.log('Badge text samples (first 10):', badgeHits.slice(0, 10));
