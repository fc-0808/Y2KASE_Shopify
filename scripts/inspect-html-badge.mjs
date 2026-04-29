// Fetch the collection page and inspect badge + product context for one product
const r = await fetch('https://y2kase.com/collections/all', {
  headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
});
const html = await r.text();

// Find the first sold-out product card context (product-data JSON embedded in page)
const productDataMatch = html.match(/product-card[^>]+data-product-id="7701462122573"([\s\S]{0,3000})/);
if (productDataMatch) {
  console.log('Kuromi Glitter card HTML (3000 chars):');
  console.log(productDataMatch[1].replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').slice(0, 1500));
} else {
  console.log('Kuromi Glitter product card not found by data-product-id');
}

// Find product JSON data embedded in the page
const jsonMatches = [...html.matchAll(/"id":7701462122573[\s\S]{0,500}/g)];
if (jsonMatches.length > 0) {
  console.log('\nProduct JSON embed:');
  jsonMatches.forEach(m => console.log(m[0].slice(0, 300)));
} else {
  // Try finding it another way
  const idx = html.indexOf('7701462122573');
  if (idx >= 0) {
    console.log('\nContext around product ID 7701462122573:');
    console.log(html.slice(Math.max(0, idx - 100), idx + 500));
  }
}

// Print first badge section HTML
const firstBadge = html.match(/class="product-badges product-badges--[\s\S]{0,600}/);
if (firstBadge) {
  console.log('\nFirst badge section:');
  console.log(firstBadge[0].slice(0, 400));
}
