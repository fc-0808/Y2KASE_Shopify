// Fetch the collection page and extract embedded product JSON data
const r = await fetch('https://y2kase.com/collections/all', {
  headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
});
const html = await r.text();

// Find the embedded product JSON for Kuromi Glitter
const idx = html.indexOf('"id":7701462122573');
if (idx < 0) { console.log('Product JSON not found'); process.exit(0); }

// Get surrounding context - find opening { and closing }
let start = idx;
while (start > 0 && html[start] !== '{') start--;
// Find matching closing bracket
let depth = 0, end = start;
while (end < html.length) {
  if (html[end] === '{') depth++;
  else if (html[end] === '}') { depth--; if (depth === 0) break; }
  end++;
}
const jsonStr = html.slice(start, end + 1);
try {
  const data = JSON.parse(jsonStr);
  console.log('Product ID:', data.id);
  console.log('Title:', data.title || data.name);
  console.log('available:', data.available);
  console.log('compare_at_price:', data.compare_at_price);
  console.log('price:', data.price);
  if (data.variants) {
    console.log('\nFirst 3 variants:');
    data.variants.slice(0, 3).forEach(v => {
      console.log(' ', v.id, '| available:', v.available, '| price:', v.price, '| inv_mgmt:', v.inventory_management);
    });
  }
} catch (e) {
  console.log('JSON parse failed, raw context:');
  console.log(jsonStr.slice(0, 800));
}
