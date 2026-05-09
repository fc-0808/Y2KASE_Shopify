import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../.env');

function loadEnv(filePath) {
  let text = readFileSync(filePath, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    process.env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
}

loadEnv(envPath);

const SHOP    = process.env.SHOPIFY_SHOP;
const TOKEN   = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const VERSION = process.env.SHOPIFY_API_VERSION || '2026-04';
const GQL_URL = `https://${SHOP}/admin/api/${VERSION}/graphql.json`;

async function gql(query) {
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': TOKEN,
    },
    body: JSON.stringify({ query }),
  });
  return res.json();
}

const marketsQuery = `{
  markets(first: 20) {
    nodes {
      id
      name
      enabled
      primary
      currencySettings {
        baseCurrency { currencyCode currencyName }
      }
      regions(first: 50) {
        nodes {
          ... on MarketRegionCountry {
            name
            code
          }
        }
      }
    }
  }
}`;

const shopQuery = `{
  shop {
    name
    currencyCode
    currencyFormats {
      moneyFormat
      moneyWithCurrencyFormat
    }
    primaryDomain { url }
    enabledPresentmentCurrencies
  }
}`;

const [marketsData, shopData] = await Promise.all([gql(marketsQuery), gql(shopQuery)]);

if (marketsData.errors) {
  console.error('GraphQL errors:', JSON.stringify(marketsData.errors, null, 2));
  process.exit(1);
}

const shop = shopData.data?.shop;
console.log('\n=== STORE ===');
console.log(`Name: ${shop?.name}`);
console.log(`Base currency: ${shop?.currencyCode}`);
console.log(`Domain: ${shop?.primaryDomain?.url}`);
console.log(`Presentment currencies enabled: ${shop?.enabledPresentmentCurrencies?.join(', ')}`);

console.log('\n=== MARKETS ===');
for (const m of marketsData.data?.markets?.nodes ?? []) {
  const currency = m.currencySettings?.baseCurrency?.currencyCode ?? 'n/a';
  const autoUpdate = 'n/a';
  const regions = m.regions?.nodes?.map(r => `${r.name} (${r.code})`).join(', ') || 'n/a';
  const status = m.enabled ? '🟢 Active' : '🔴 Disabled';
  const primary = m.primary ? ' [PRIMARY]' : '';
  console.log(`\n${status}${primary}  ${m.name}`);
  console.log(`  Currency: ${currency}  |  Auto-update rates: ${autoUpdate}`);
  console.log(`  Regions: ${regions}`);
}
