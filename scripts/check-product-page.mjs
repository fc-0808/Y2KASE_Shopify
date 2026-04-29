const r = await fetch('https://y2kase.com/products/kuromi-style-my-melody-glitter-case-w-3d-57558', {
  headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
});
const html = await r.text();

const disabledBtns = (html.match(/type="submit"[^>]*disabled/g) || []).length;
const addBtns      = (html.match(/name="add"/g) || []).length;
const soldOut      = (html.match(/sold.out/gi) || []).length;

console.log('Submit buttons with disabled attr:', disabledBtns);
console.log('Name=add buttons:', addBtns);
console.log('Sold out occurrences:', soldOut);

// Find buy button context
const addBtnMatch = html.match(/name="add"[^>]{0,300}/);
if (addBtnMatch) console.log('\nAdd button attrs:', addBtnMatch[0].slice(0, 200));

// Check what text the main buy button shows
const buyBtnText = html.match(/add-to-cart-text__content[\s\S]{0,200}/);
if (buyBtnText) {
  const text = buyBtnText[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  console.log('\nBuy button text:', text);
}
