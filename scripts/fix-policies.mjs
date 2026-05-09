import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
function loadEnv(f) {
  let t = readFileSync(f, 'utf8');
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  for (const line of t.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq === -1) continue;
    process.env[s.slice(0, eq).trim()] = s.slice(eq + 1).trim();
  }
}
loadEnv(resolve(__dirname, '../.env'));

const SHOP  = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const VER   = process.env.SHOPIFY_API_VERSION || '2026-04';
const GQL   = `https://${SHOP}/admin/api/${VER}/graphql.json`;

const gql = async (query, variables = {}) => {
  const r = await fetch(GQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  return r.json();
};

const POLICIES = [
  {
    type: 'REFUND_POLICY',
    body: `<h1>Refund & Return Policy</h1><p>We accept returns within <strong>30 days</strong> of delivery. Items must be unused, in original condition, and in original packaging.</p><h2>Refunds</h2><p>Approved refunds are processed within <strong>5–7 business days</strong> to your original payment method.</p><h2>Exchanges</h2><p>We offer exchanges for different variants within 30 days. Contact us at <a href="mailto:hello@y2kase.com">hello@y2kase.com</a>.</p><h2>Damaged Items</h2><p>If your item arrives damaged, contact us within 7 days with photos and we'll send a replacement at no cost.</p>`,
  },
  {
    type: 'SHIPPING_POLICY',
    body: `<h1>Shipping Policy</h1><h2>Processing Time</h2><p>Orders are processed within <strong>1–3 business days</strong>.</p><h2>Shipping Times</h2><p>Hong Kong: 1–3 days. United States: 7–14 days. United Kingdom: 7–14 days. European Union: 7–14 days. Rest of World: 10–21 days. Express options available at checkout.</p><h2>Tracking</h2><p>All orders include tracking sent by email once dispatched.</p><h2>Customs</h2><p>International orders may be subject to customs duties payable by the buyer.</p>`,
  },
  {
    type: 'PRIVACY_POLICY',
    body: `<h1>Privacy Policy</h1><p>Y2KASE is committed to protecting your personal information.</p><h2>Information We Collect</h2><p>Order details, shipping address, payment info (processed by Shopify Payments), and browsing data via cookies.</p><h2>How We Use It</h2><p>To process orders, send shipping updates, and improve our store. Marketing emails only with your consent.</p><h2>Your Rights</h2><p>EU/UK customers may request access, correction, or deletion of personal data. Contact <a href="mailto:hello@y2kase.com">hello@y2kase.com</a>.</p><h2>Data Retention</h2><p>Order data retained 7 years for accounting purposes.</p>`,
  },
  {
    type: 'TERMS_OF_SERVICE',
    body: `<h1>Terms of Service</h1><p>By purchasing from Y2KASE you agree to these terms.</p><h2>Products</h2><p>Colours may vary due to screen settings. We reserve the right to limit quantities.</p><h2>Orders</h2><p>We may cancel orders due to pricing errors, stock issues, or suspected fraud with full refund.</p><h2>Character Licensing</h2><p>Sanrio characters are trademarks of Sanrio Co., Ltd. Disney characters are trademarks of The Walt Disney Company.</p><h2>Governing Law</h2><p>These terms are governed by the laws of Hong Kong SAR.</p><p>Contact: <a href="mailto:hello@y2kase.com">hello@y2kase.com</a></p>`,
  },
];

console.log('Setting policies...\n');

for (const policy of POLICIES) {
  const result = await gql(`
    mutation {
      shopPolicyUpdate(shopPolicy: { type: ${policy.type}, body: ${JSON.stringify(policy.body)} }) {
        userErrors { field message }
        shopPolicy { type url title }
      }
    }
  `);

  const errs = result.data?.shopPolicyUpdate?.userErrors;
  if (result.errors?.length) {
    console.error(`❌ ${policy.type} - GraphQL error:`, JSON.stringify(result.errors[0].message));
  } else if (errs?.length) {
    console.error(`❌ ${policy.type} - User error:`, JSON.stringify(errs));
  } else {
    console.log(`✅ ${policy.type} set`);
  }
}

// Verify
console.log('\nVerifying...');
const check = await gql(`{
  shop {
    refundPolicy { body }
    shippingPolicy { body }
    privacyPolicy { body }
    termsOfService { body }
  }
}`);

const s = check.data?.shop || {};
const pMap = {
  'Refund Policy':    s.refundPolicy,
  'Shipping Policy':  s.shippingPolicy,
  'Privacy Policy':   s.privacyPolicy,
  'Terms of Service': s.termsOfService,
};
for (const [name, p] of Object.entries(pMap)) {
  if (p?.body?.length > 50) console.log(`  ✅ ${name}: ${p.body.length} chars`);
  else console.error(`  ❌ ${name}: empty or null`);
}
