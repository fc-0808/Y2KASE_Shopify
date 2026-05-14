/**
 * Shared Shopify Admin API client
 *
 * Exports:
 *   BASE_URL          — REST base URL (preserved for all existing scripts)
 *   shopifyFetch      — REST fetch helper (preserved, unchanged)
 *   shopifyGql        — GraphQL client with leaky-bucket throttle + exponential backoff
 *   resolveLocationId — Resolve a location name → GID, cached for the session
 *   findProductByHandle — Check if a product handle already exists in the store
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── .env loader ───────────────────────────────────────────────────────────────
function loadEnv() {
  try {
    const envPath = resolve(__dirname, '../.env');
    const lines = readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [key, ...rest] = trimmed.split('=');
      process.env[key.trim()] = rest.join('=').trim();
    }
  } catch {
    // .env not found — rely on real environment variables
  }
}

loadEnv();

const STORE   = process.env.SHOPIFY_SHOP?.trim() || process.env.SHOPIFY_STORE?.trim();
const TOKEN   = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN?.trim();
const VERSION = process.env.SHOPIFY_API_VERSION || '2026-04';

if (!STORE || !TOKEN) {
  console.error(
    'Missing SHOPIFY_SHOP (or SHOPIFY_STORE) or SHOPIFY_ADMIN_ACCESS_TOKEN in .env.'
  );
  process.exit(1);
}

export const BASE_URL = `https://${STORE}/admin/api/${VERSION}`;
const GQL_URL         = `${BASE_URL}/graphql.json`;

// ── Shared helpers ────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Exponential backoff with full jitter.
 * Attempt 0 → ~1s, 1 → ~2s, 2 → ~4s … capped at 32s.
 * Jitter (0–1s) prevents thundering-herd retry storms.
 *
 * @param {number} attempt - zero-based retry count
 * @returns {number} milliseconds to wait
 */
function backoffMs(attempt) {
  const base   = 1_000;
  const cap    = 32_000;
  const jitter = Math.random() * 1_000;
  return Math.min(base * (2 ** attempt), cap) + jitter;
}

// ── Rate-limit state (module singleton, shared across all calls in a session) ─
//
// Shopify uses two parallel throttle mechanisms:
//
//  REST (Leaky Bucket):
//    Header: X-Shopify-Shop-Api-Call-Limit: <used>/<max>
//    Bucket refills at 2 req/s (standard) or 4 req/s (Plus).
//    We pause when used ≥ 87.5% of max (35/40 standard, 70/80 Plus).
//
//  GraphQL (Query Cost):
//    Field: response.extensions.cost.throttleStatus
//    Bucket size: 1000 points (standard) / 2000 (Plus).
//    Restore rate: 50 pts/s (standard) / 100 pts/s (Plus).
//    We pause when availablePoints < GRAPHQL_SAFETY_MARGIN.
//
const rate = {
  restUsed:        0,
  restMax:         40,
  gqlAvailable:    1000,
  gqlMax:          1000,
  gqlRestoreRate:  50,
};

const REST_THROTTLE_RATIO   = 0.875; // pause at 35/40 (87.5%)
const GRAPHQL_SAFETY_MARGIN = 150;   // pause when < 150 points available

// ── Existing export — preserved verbatim ─────────────────────────────────────

export async function shopifyFetch(endpoint, options = {}) {
  const url = `${BASE_URL}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': TOKEN,
      ...options.headers,
    },
  });

  // Update leaky-bucket state from REST header
  const callLimit = res.headers.get('X-Shopify-Shop-Api-Call-Limit');
  if (callLimit) {
    const [used, max] = callLimit.split('/').map(Number);
    rate.restUsed = used;
    rate.restMax  = max;
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify API error ${res.status}: ${body}`);
  }

  return res.json();
}

// ── GraphQL client with full resilience ──────────────────────────────────────

/**
 * Execute a Shopify Admin GraphQL mutation or query.
 *
 * Resilience built in:
 *  • Proactive REST leaky-bucket throttle (X-Shopify-Shop-Api-Call-Limit)
 *  • Proactive GraphQL cost throttle (extensions.cost.throttleStatus)
 *  • Retry on HTTP 429 (Too Many Requests) — honours Retry-After header
 *  • Retry on HTTP 503 (Service Unavailable) — exponential backoff with jitter
 *  • Retry on GraphQL THROTTLED error — waits for bucket refill
 *  • Max 6 attempts before throwing
 *
 * @param {string} query     - GraphQL query or mutation string
 * @param {object} variables - GraphQL variables object
 * @param {number} _attempt  - internal retry counter (do not pass externally)
 * @returns {Promise<object>} Parsed JSON response body
 */
export async function shopifyGql(query, variables = {}, _attempt = 0) {
  const MAX_ATTEMPTS = 6;

  if (_attempt >= MAX_ATTEMPTS) {
    throw new Error(`Shopify GraphQL: exceeded ${MAX_ATTEMPTS} retry attempts`);
  }

  // ── Proactive REST bucket throttle ─────────────────────────────────────────
  if (rate.restMax > 0 && (rate.restUsed / rate.restMax) >= REST_THROTTLE_RATIO) {
    const surplus  = rate.restUsed - Math.floor(rate.restMax * REST_THROTTLE_RATIO);
    const waitMs   = Math.ceil(surplus / 2) * 1_000; // refill rate: 2/s
    process.stdout.write(
      `  [rate] REST bucket ${rate.restUsed}/${rate.restMax} — waiting ${waitMs}ms…\r`
    );
    await sleep(waitMs);
  }

  // ── Proactive GraphQL cost throttle ────────────────────────────────────────
  if (rate.gqlAvailable < GRAPHQL_SAFETY_MARGIN) {
    const pointsNeeded = GRAPHQL_SAFETY_MARGIN - rate.gqlAvailable;
    const waitMs       = Math.ceil(pointsNeeded / rate.gqlRestoreRate) * 1_000 + 500;
    process.stdout.write(
      `  [rate] GQL bucket ${rate.gqlAvailable}/${rate.gqlMax} pts — waiting ${waitMs}ms…\r`
    );
    await sleep(waitMs);
  }

  // ── Fire the request ───────────────────────────────────────────────────────
  // Wrap in try/catch so transport-level failures (ECONNRESET, DNS, TCP
  // timeout, "fetch failed" TypeError) are caught here and retried with
  // the same exponential back-off as HTTP 503, rather than propagating
  // as an uncaught exception that kills the entire import pipeline.
  let res;
  try {
    res = await fetch(GQL_URL, {
      method:  'POST',
      headers: {
        'Content-Type':          'application/json',
        'X-Shopify-Access-Token': TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (fetchErr) {
    if (_attempt < MAX_ATTEMPTS - 1) {
      const waitMs = backoffMs(_attempt);
      process.stdout.write(
        `\n  [net] ${fetchErr.message} — backoff ${Math.round(waitMs)}ms (attempt ${_attempt + 1}/${MAX_ATTEMPTS})…\r`
      );
      await sleep(waitMs);
      return shopifyGql(query, variables, _attempt + 1);
    }
    throw fetchErr;
  }

  // ── Update REST bucket state ───────────────────────────────────────────────
  const callLimit = res.headers.get('X-Shopify-Shop-Api-Call-Limit');
  if (callLimit) {
    const [used, max] = callLimit.split('/').map(Number);
    rate.restUsed = used;
    rate.restMax  = max;
  }

  // ── HTTP 429: Too Many Requests ────────────────────────────────────────────
  if (res.status === 429) {
    const retryAfterSec = parseFloat(res.headers.get('Retry-After') ?? '2');
    const waitMs        = retryAfterSec * 1_000 + 250;
    process.stdout.write(
      `\n  [429] Rate limited — waiting ${retryAfterSec}s (attempt ${_attempt + 1}/${MAX_ATTEMPTS})…\r`
    );
    await sleep(waitMs);
    return shopifyGql(query, variables, _attempt + 1);
  }

  // ── HTTP 503: Service Unavailable ─────────────────────────────────────────
  if (res.status === 503) {
    const waitMs = backoffMs(_attempt);
    process.stdout.write(
      `\n  [503] Unavailable — backoff ${Math.round(waitMs)}ms (attempt ${_attempt + 1}/${MAX_ATTEMPTS})…\r`
    );
    await sleep(waitMs);
    return shopifyGql(query, variables, _attempt + 1);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify GraphQL HTTP error ${res.status}: ${body}`);
  }

  const json = await res.json();

  // ── Update GraphQL cost bucket state ──────────────────────────────────────
  const costExt = json.extensions?.cost;
  if (costExt?.throttleStatus) {
    const ts            = costExt.throttleStatus;
    rate.gqlAvailable   = ts.currentlyAvailable;
    rate.gqlMax         = ts.maximumAvailable;
    rate.gqlRestoreRate = ts.restoreRate;
  }

  // ── GraphQL THROTTLED error (HTTP 200 but bucket exceeded) ────────────────
  const throttledError = json.errors?.find(e => e.extensions?.code === 'THROTTLED');
  if (throttledError) {
    const ts         = costExt?.throttleStatus;
    const needed     = costExt?.requestedQueryCost ?? 100;
    const available  = ts?.currentlyAvailable ?? 0;
    const restoreRate = ts?.restoreRate ?? rate.gqlRestoreRate;
    const waitMs     = Math.ceil((needed - available) / restoreRate) * 1_000 + 500;
    process.stdout.write(
      `\n  [GQL throttle] ${available} pts available, ${needed} needed — waiting ${Math.round(waitMs)}ms…\r`
    );
    await sleep(waitMs);
    return shopifyGql(query, variables, _attempt + 1);
  }

  return json;
}

// ── Location resolver ─────────────────────────────────────────────────────────

// Session cache — resolved once, reused for all inventory calls
let _cachedLocationId   = null;
let _cachedLocationName = null;

const LOCATIONS_QUERY = `
  query {
    locations(first: 50, includeInactive: false) {
      edges {
        node {
          id
          name
          isActive
          fulfillsOnlineOrders
        }
      }
    }
  }
`;

/**
 * Resolve a Shopify location name to its GID, with session caching.
 *
 * @param {string} locationName - Exact location name as shown in Shopify Admin > Settings > Locations
 * @returns {Promise<string>} Location GID (e.g. "gid://shopify/Location/12345678")
 * @throws {Error} If the location name is not found (lists available names for debugging)
 */
export async function resolveLocationId(locationName) {
  if (_cachedLocationId && _cachedLocationName === locationName) {
    return _cachedLocationId;
  }

  const result = await shopifyGql(LOCATIONS_QUERY);

  if (result.errors?.length > 0) {
    throw new Error(`Location query failed: ${result.errors[0].message}`);
  }

  const locations = result.data.locations.edges.map(({ node }) => node);

  // Case-insensitive match with trim to handle trailing whitespace in the Admin UI
  const match = locations.find(
    loc => loc.name.trim().toLowerCase() === locationName.trim().toLowerCase()
  );

  if (!match) {
    const available = locations.map(l => `  • "${l.name}" (active: ${l.isActive})`).join('\n');
    throw new Error(
      `Location "${locationName}" not found in Shopify.\nAvailable locations:\n${available}`
    );
  }

  _cachedLocationId   = match.id;
  _cachedLocationName = locationName;

  return match.id;
}

// ── Product deduplication check ───────────────────────────────────────────────

const PRODUCT_BY_HANDLE_QUERY = `
  query productByHandle($handle: String!) {
    productByIdentifier(identifier: { handle: $handle }) {
      id
      title
      status
    }
  }
`;

/**
 * Check whether a product with the given handle already exists in the store.
 *
 * @param {string} handle - URL-safe product handle (e.g. "hello-kitty-clear-iphone-case")
 * @returns {Promise<{id: string, title: string, status: string}|null>}
 *   Returns the existing product object if found, or null if the handle is free.
 */
export async function findProductByHandle(handle) {
  const result = await shopifyGql(PRODUCT_BY_HANDLE_QUERY, { handle });

  if (result.errors?.length > 0) {
    // Non-fatal: if the query fails, assume the product doesn't exist
    console.warn(`  [WARN] Handle check failed for "${handle}": ${result.errors[0].message}`);
    return null;
  }

  return result.data?.productByIdentifier ?? null;
}
