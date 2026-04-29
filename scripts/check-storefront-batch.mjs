// Check multiple products via Storefront GraphQL to see which are available
const sfQuery = `{
  p1: product(handle: "kuromi-style-my-melody-glitter-case-w-3d-57558") {
    title availableForSale
    variants(first: 2) { edges { node { availableForSale currentlyNotInStock } } }
  }
  p2: product(handle: "chiikawa-magsafe-case-iphone-17-16-15-14-96054") {
    title availableForSale
    variants(first: 2) { edges { node { availableForSale currentlyNotInStock } } }
  }
  p3: product(handle: "hello-kitty-leopard-iphone-case-y2k-gyaru-shaker-grip") {
    title availableForSale
    variants(first: 2) { edges { node { availableForSale currentlyNotInStock } } }
  }
}`;

const r = await fetch('https://y2kase-1435.myshopify.com/api/2025-04/graphql.json', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sfQuery }),
});
const d = await r.json();
if (d.errors) {
  console.log('Errors:', d.errors.map(e => e.message));
} else {
  Object.entries(d.data).forEach(([key, p]) => {
    if (!p) { console.log(key, '- product not found'); return; }
    console.log(`${key}: ${p.title}`);
    console.log(`  availableForSale: ${p.availableForSale}`);
    p.variants.edges.forEach(e => {
      console.log(`  variant: availableForSale=${e.node.availableForSale} | currentlyNotInStock=${e.node.currentlyNotInStock}`);
    });
  });
}
