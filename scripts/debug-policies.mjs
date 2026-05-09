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

// Check what policy mutations exist
const mutations = await gql(`{
  __schema {
    mutationType {
      fields {
        name
        args { name type { name kind ofType { name } } }
      }
    }
  }
}`);

const policyMuts = mutations.data?.__schema?.mutationType?.fields
  ?.filter(f => f.name.toLowerCase().includes('policy'));
console.log('Policy mutations:', JSON.stringify(policyMuts?.map(f => ({ name: f.name, args: f.args?.map(a => a.name) })), null, 2));

// Check ShopPolicyInput type
const inputType = await gql(`{
  __type(name: "ShopPolicyInput") {
    inputFields { name type { name kind ofType { name } } }
  }
}`);
console.log('\nShopPolicyInput:', JSON.stringify(inputType.data?.__type?.inputFields, null, 2));

// Check ShopPolicyType enum
const enumType = await gql(`{
  __type(name: "ShopPolicyType") {
    enumValues { name }
  }
}`);
console.log('\nShopPolicyType values:', JSON.stringify(enumType.data?.__type?.enumValues?.map(e => e.name)));

// Try to read current policies
const current = await gql(`{
  shop {
    refundPolicy { title body }
    shippingPolicy { title body }
    privacyPolicy { title body }
    termsOfService { title body }
  }
}`);
const s = current.data?.shop;
console.log('\nCurrent policies:');
for (const [k, v] of Object.entries(s || {})) {
  console.log(`  ${k}: ${v ? v.body?.slice(0,50) + '...' : 'NOT SET'}`);
}
