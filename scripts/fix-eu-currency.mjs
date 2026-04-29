/**
 * Fix EU market: set base currency to EUR
 */
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
const VERSION = process.env.SHOPIFY_API_VERSION || '2025-04';
const GQL_URL = `https://${SHOP}/admin/api/${VERSION}/graphql.json`;

async function gql(query, variables = {}) {
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

// Find EU market
const findEU = await gql(`{
  markets(first: 20) {
    nodes {
      id
      name
      currencySettings { baseCurrency { currencyCode } }
    }
  }
}`);

const euMarket = findEU.data?.markets?.nodes?.find(m => m.name === 'European Union');
if (!euMarket) {
  console.error('EU market not found.');
  process.exit(1);
}

console.log(`EU market ID: ${euMarket.id}`);
console.log(`Current currency: ${euMarket.currencySettings?.baseCurrency?.currencyCode}`);

// Update to EUR using correct type: MarketUpdateInput
const update = await gql(`
  mutation marketUpdate($id: ID!, $input: MarketUpdateInput!) {
    marketUpdate(id: $id, input: $input) {
      market {
        id
        name
        currencySettings { baseCurrency { currencyCode currencyName } }
      }
      userErrors { field message code }
    }
  }
`, {
  id: euMarket.id,
  input: {
    currencySettings: {
      baseCurrency: 'EUR',
    },
  },
});

const userErrors = update.data?.marketUpdate?.userErrors;
if (userErrors?.length) {
  console.error('User errors:', JSON.stringify(userErrors, null, 2));
  process.exit(1);
}
if (update.errors?.length) {
  console.error('GraphQL errors:', JSON.stringify(update.errors, null, 2));
  process.exit(1);
}

const market = update.data?.marketUpdate?.market;
console.log(`\nEU market currency updated to: ${market?.currencySettings?.baseCurrency?.currencyCode} (${market?.currencySettings?.baseCurrency?.currencyName})`);
console.log('EU customers will now see prices in EUR.');
