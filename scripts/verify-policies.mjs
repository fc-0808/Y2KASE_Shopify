import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
function loadEnv(f) {
  let t = readFileSync(f, 'utf8'); if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  for (const line of t.split(/\r?\n/)) { const s = line.trim(); if (!s || s.startsWith('#')) continue; const eq = s.indexOf('='); if (eq === -1) continue; process.env[s.slice(0,eq).trim()] = s.slice(eq+1).trim(); }
}
loadEnv(resolve(__dirname, '../.env'));
const SHOP=process.env.SHOPIFY_SHOP,TOKEN=process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,VER=process.env.SHOPIFY_API_VERSION||'2026-04';

// REST check
const r = await fetch(`https://${SHOP}/admin/api/${VER}/policies.json`, { headers:{'X-Shopify-Access-Token':TOKEN} });
const data = await r.json();
console.log('\nREST /policies.json:');
for (const p of data.policies||[]) {
  const chars = p.body?.replace(/<[^>]+>/g,'').trim().length || 0;
  console.log(`  ${chars>50?'✅':'❌'} ${p.title || p.id}: ${chars} chars — ${p.url}`);
}

// GraphQL check with correct field names
const gqlR = await fetch(`https://${SHOP}/admin/api/${VER}/graphql.json`, {
  method:'POST', headers:{'Content-Type':'application/json','X-Shopify-Access-Token':TOKEN},
  body: JSON.stringify({ query: `{ shop { name shopPolicies { type body url } } }` })
});
const gqlData = await gqlR.json();
console.log('\nGraphQL shopPolicies:');
if (gqlData.errors) console.log('  GraphQL errors:', JSON.stringify(gqlData.errors[0]?.message));
else {
  for (const p of gqlData.data?.shop?.shopPolicies||[]) {
    const chars = p.body?.replace(/<[^>]+>/g,'').trim().length || 0;
    console.log(`  ${chars>50?'✅':'❌'} ${p.type}: ${chars} chars`);
  }
}
