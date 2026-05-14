/**
 * Y2KASE Phase 4 — Load Layer
 *
 * Orchestrates the four-mutation sequence required to fully create a product
 * in Shopify from a transformed payload:
 *
 *   Step 1 — productSet
 *     Creates the product record with all options, 72 variants, SEO fields,
 *     CUSTOM namespace metafields, and the taxonomy category GID in a single
 *     atomic GraphQL call.  Returns: productId + inventoryItemId per variant.
 *
 *     `shopify` namespace metafields are excluded here — inline MetafieldInput
 *     for `shopify.*` keys causes INVALID_METAFIELD errors.  They are handled
 *     in Step 4 after the product exists.
 *
 *   Step 2 — productCreateMedia
 *     Attaches Etsy image URLs to the created product.
 *     Called separately because ProductSetInput does not accept media.
 *
 *   Step 3 — inventorySetOnHandQuantities
 *     Sets the on-hand stock quantity for every variant at the resolved
 *     fulfilment location. Batched to 100 items per call if needed.
 *
 *   Step 4 — metafieldsSet  (CONDITIONAL — requires bootstrap cache)
 *     Sets the 4 taxonomy attributes that have Shopify Standard Metafield
 *     Definitions enabled on this store:
 *       • shopify.material
 *       • shopify.theme
 *       • shopify.attachment-options
 *       • shopify.connectivity-technology
 *
 *     Step 4 only runs if .cache/taxonomy-metaobj-gid-cache.json exists.
 *     Bootstrap once by:
 *       1. Setting any Category metafield value manually in Shopify Admin
 *       2. Running: node scripts/lib/discover-metaobj-gids.mjs
 *
 *     The remaining Category metafields (case-type, magsafe-compatibility,
 *     bag-case-material, finish, etc.) cannot be set by private apps —
 *     Shopify returns APP_NOT_AUTHORIZED for those namespace/key combinations.
 *     They must be filled manually in Shopify Admin → Product → Category.
 *     The dashboard Product Inspector shows the intended values as a reference.
 *
 * All API calls are routed through shopifyGql() in shopify-client.mjs,
 * which provides rate limiting and retry logic — this module stays pure.
 */

import { existsSync, readFileSync } from 'fs';
import { resolve, dirname }         from 'path';
import { fileURLToPath }            from 'url';
import { shopifyGql, findProductByHandle } from '../shopify-client.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Metaobject GID cache (populated by discover-metaobj-gids.mjs) ─────────────
// Maps display name → Metaobject GID for the 4 standard-template attributes.
// Format: { attributes: { theme: { "Cartoons": "gid://shopify/Metaobject/XXX" } } }
const METAOBJ_CACHE_PATH = resolve(__dirname, '../../.cache/taxonomy-metaobj-gid-cache.json');
const TAXONOMY_CACHE_PATH = resolve(__dirname, '../../.cache/taxonomy-attrs-cache.json');

let _mobjCache  = null;
let _taxonCache = null;

function getMobjCache() {
  if (_mobjCache !== null) return _mobjCache;
  if (existsSync(METAOBJ_CACHE_PATH)) {
    try { _mobjCache = JSON.parse(readFileSync(METAOBJ_CACHE_PATH, 'utf-8')); }
    catch { _mobjCache = { attributes: {} }; }
  } else {
    _mobjCache = { attributes: {} };
  }
  return _mobjCache;
}

function getTaxonCache() {
  if (_taxonCache !== null) return _taxonCache;
  if (existsSync(TAXONOMY_CACHE_PATH)) {
    try { _taxonCache = JSON.parse(readFileSync(TAXONOMY_CACHE_PATH, 'utf-8')); }
    catch { _taxonCache = { attributes: {} }; }
  } else {
    _taxonCache = { attributes: {} };
  }
  return _taxonCache;
}

// The 4 taxonomy attributes for which we have enabled standard definitions.
// Values must be submitted as list.metaobject_reference using Metaobject GIDs,
// NOT as list.product_taxonomy_value_reference with TaxonomyValue GIDs.
const STANDARD_DEF_ATTRS = new Set([
  'material',
  'theme',
  'attachment-options',
  'connectivity-technology',
]);

// ── GraphQL mutation strings ──────────────────────────────────────────────────

export const PRODUCT_SET_MUTATION = /* GraphQL */ `
  mutation productSet($synchronous: Boolean!, $input: ProductSetInput!) {
    productSet(synchronous: $synchronous, input: $input) {
      product {
        id
        title
        handle
        status
        variants(first: 250) {
          edges {
            node {
              id
              sku
              inventoryItem {
                id
              }
            }
          }
        }
      }
      productSetOperation {
        id
        status
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export const PRODUCT_CREATE_MEDIA_MUTATION = /* GraphQL */ `
  mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media {
        id
        alt
        mediaContentType
        status
      }
      mediaUserErrors {
        field
        message
        code
      }
      product {
        id
      }
    }
  }
`;

// @idempotent directive is REQUIRED for this mutation in Shopify API 2026-04+.
// Each call must supply a unique idempotencyKey UUID to prevent duplicate adjustments.
export const INVENTORY_SET_MUTATION = /* GraphQL */ `
  mutation inventorySetOnHandQuantities($input: InventorySetOnHandQuantitiesInput!, $idempotencyKey: String!) {
    inventorySetOnHandQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      userErrors {
        field
        message
        code
      }
      inventoryAdjustmentGroup {
        createdAt
        reason
        changes {
          name
          delta
          quantityAfterChange
        }
      }
    }
  }
`;

// Step 4 — metafieldsSet for `shopify` namespace taxonomy attributes.
// These cannot be sent inside productSet because the `shopify` namespace is
// reserved for Shopify-owned definitions; apps must use metafieldsSet with an
// explicit ownerId to write taxonomy value references post-creation.
export const METAFIELDS_SET_MUTATION = /* GraphQL */ `
  mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

// ── Variable builders ─────────────────────────────────────────────────────────

/**
 * Build the variables object for the productSet mutation.
 * Strips pipeline-internal _ fields and `shopify` namespace metafields
 * before sending to the API.
 *
 * Fields explicitly included:
 *   Core:            title, descriptionHtml, handle, vendor, productType, status
 *   Taxonomy:        category         ← required to set the Shopify product category (API 2026-04)
 *   Collections:     collections      ← required to assign auto-detected collections
 *   Discovery:       tags, seo, metafields (custom namespace only)
 *   Variant matrix:  productOptions, variants
 *
 * `shopify` namespace metafields are excluded here because the productSet
 * mutation rejects them (INVALID_METAFIELD) — the `shopify` namespace is a
 * Shopify-reserved system namespace, not writable via app-owned definitions.
 * They are forwarded to Step 4 (metafieldsSet) after the product is created.
 *
 * @param {object} payload - output of buildShopifyPayload() from transform.mjs
 * @returns {{ synchronous: boolean, input: object }}
 */
export function buildProductSetVariables(payload, existingId = null) {
  // Partition metafields: only non-shopify namespace ones go into productSet.
  // `shopify` namespace taxonomy attributes are sent via metafieldsSet (Step 4).
  const inlineMetafields = (payload.metafields ?? []).filter(mf => mf.namespace !== 'shopify');

  const input = {
    // When updating an existing product pass its GID so Shopify targets the
    // correct record.  Without this, productSet would create a second product
    // and auto-suffix the handle (e.g. "my-case-2") instead of updating.
    ...(existingId ? { id: existingId } : {}),
    title:           payload.title,
    descriptionHtml: payload.descriptionHtml,
    handle:          payload.handle,
    vendor:          payload.vendor,
    productType:     payload.productType,
    status:          payload.status,   // always 'DRAFT'
    tags:            payload.tags,
    seo:             payload.seo,
    productOptions:  payload.productOptions,
    variants:        payload.variants,
  };

  // Only include metafields if there are any — an empty array sent to a
  // productSet UPDATE would clear all existing custom metafields.
  if (inlineMetafields.length > 0) {
    input.metafields = inlineMetafields;
  }

  // Shopify Standard Product Category — API 2026-04 uses a flat `category` GID scalar.
  // Priority: payload.category (direct GID) → productCategory nested object → string fallback.
  // Passing undefined omits the field entirely; omitting it leaves the category blank in Admin.
  const categoryId = payload.category
    ?? payload.productCategory?.productTaxonomyNodeId
    ?? (typeof payload.productCategory === 'string' ? payload.productCategory : null);
  if (categoryId) {
    input.category = categoryId;
  }

  // Collection membership — API 2026-04 uses `collections` (renamed from collectionsToJoin).
  // `collections` is a list field: on UPDATE it REPLACES existing memberships,
  // so only include it for brand-new products to avoid wiping manual overrides.
  if (!existingId && Array.isArray(payload.collections) && payload.collections.length > 0) {
    input.collections = payload.collections;
  }

  return { synchronous: true, input };
}

/**
 * Build the variables object for productCreateMedia.
 *
 * @param {string}   productId - GID returned from Step 1
 * @param {object[]} images    - payload._images array
 * @returns {{ productId: string, media: object[] }}
 */
export function buildMediaVariables(productId, images) {
  return {
    productId,
    media: images.map(img => ({
      alt:               img.alt,
      mediaContentType:  'IMAGE',
      originalSource:    img.src,
    })),
  };
}

/**
 * Build the variables object for inventorySetOnHandQuantities.
 *
 * As of Shopify API 2026-04, the @idempotent directive is REQUIRED on this
 * mutation. A unique idempotencyKey must be provided per call to prevent
 * duplicate inventory adjustments on retries.
 *
 * @param {object[]} inventoryItems  - [{inventoryItemId, sku}] from Step 1 response
 * @param {string}   locationId      - GID from resolveLocationId()
 * @param {number}   qty             - on-hand quantity to set
 * @param {string}   idempotencyKey  - UUID unique to this specific batch call
 * @returns {{ input: object, idempotencyKey: string }}
 */
export function buildInventoryVariables(inventoryItems, locationId, qty, idempotencyKey) {
  return {
    input: {
      reason: 'correction',
      setQuantities: inventoryItems.map(item => ({
        inventoryItemId:    item.inventoryItemId,
        locationId,
        quantity:           qty,
        changeFromQuantity: null,
      })),
    },
    idempotencyKey,
  };
}

/**
 * Build the variables for the Step 4 metafieldsSet call.
 * Maps each MetafieldInput to MetafieldsSetInput by adding the required ownerId.
 *
 * @param {string}   productId  - GID returned from Step 1
 * @param {object[]} metafields - shopify-namespace MetafieldInput objects
 * @returns {{ metafields: object[] }}
 */
export function buildTaxonomyMetafieldsVariables(productId, metafields) {
  return {
    metafields: metafields.map(mf => ({
      ownerId:   productId,
      namespace: mf.namespace,
      key:       mf.key,
      type:      mf.type,
      value:     mf.value,
    })),
  };
}

/**
 * Convert the payload's `shopify` namespace metafields (which carry TaxonomyValue
 * GIDs) into the `list.metaobject_reference` format required by the four standard
 * definitions we enabled via standardMetafieldDefinitionEnable.
 *
 * The conversion path:
 *   TaxonomyValue GID  →  display name (via taxonomy attrs cache)
 *   display name       →  Metaobject GID  (via metaobject GID cache from discover-metaobj-gids)
 *
 * Returns an empty array if the Metaobject GID cache is missing (bootstrap not done).
 *
 * @param {object[]} shopifyMetafields - shopify.* MetafieldInputs from payload.metafields
 * @returns {object[]}  MetafieldInput[]  ready for Step 4 metafieldsSet
 */
export function buildStandardAttrMetafields(shopifyMetafields) {
  const mobjCache  = getMobjCache();
  const taxonCache = getTaxonCache();

  // Need at least one attribute in the metaobject cache
  if (!mobjCache.attributes || Object.keys(mobjCache.attributes).length === 0) {
    return [];
  }

  // Build reverse map: TaxonomyValue GID → display name (for each standard attr)
  const reverseMap = {};   // { attrKey: { "gid://shopify/TaxonomyValue/XXX": "Cartoons" } }
  for (const attrKey of STANDARD_DEF_ATTRS) {
    const attrData = taxonCache.attributes?.[attrKey];
    if (!attrData?.values) continue;
    reverseMap[attrKey] = {};
    for (const [name, tvGid] of Object.entries(attrData.values)) {
      reverseMap[attrKey][tvGid] = name;
    }
  }

  const result = [];
  for (const mf of shopifyMetafields) {
    if (!STANDARD_DEF_ATTRS.has(mf.key)) continue;
    const mobjAttr = mobjCache.attributes[mf.key];
    if (!mobjAttr || Object.keys(mobjAttr).length === 0) continue;

    // Decode TaxonomyValue GIDs from the payload value
    let tvGids;
    try { tvGids = JSON.parse(mf.value); } catch { continue; }
    if (!Array.isArray(tvGids) || tvGids.length === 0) continue;

    // Map each TaxonomyValue GID → display name → Metaobject GID
    const mobjGids = tvGids
      .map(tvGid => {
        const displayName = reverseMap[mf.key]?.[tvGid];
        if (!displayName) return null;
        return mobjAttr[displayName] ?? null;
      })
      .filter(Boolean);

    if (mobjGids.length === 0) continue;

    result.push({
      namespace: 'shopify',
      key:       mf.key,
      type:      'list.metaobject_reference',
      value:     JSON.stringify(mobjGids),
    });
  }

  return result;
}

// ── Individual step executors ─────────────────────────────────────────────────

/**
 * Step 1: Create product with all variants via productSet.
 *
 * @param {object} payload - transformed payload from buildShopifyPayload()
 * @returns {{ id, title, handle, inventoryItems: [{inventoryItemId, sku, variantId}] }}
 */
async function stepCreateProduct(payload, existingId = null) {
  const variables = buildProductSetVariables(payload, existingId);
  const result    = await shopifyGql(PRODUCT_SET_MUTATION, variables);

  if (result.errors?.length > 0) {
    throw new Error(`productSet network error: ${result.errors.map(e => e.message).join('; ')}`);
  }

  const ps = result.data?.productSet;
  if (!ps) throw new Error('productSet: unexpected empty response');

  if (ps.userErrors?.length > 0) {
    const msgs = ps.userErrors.map(e => `[${e.field}] ${e.message} (${e.code})`).join('\n    ');
    throw new Error(`productSet userErrors:\n    ${msgs}`);
  }

  const product        = ps.product;
  const inventoryItems = product.variants.edges.map(({ node }) => ({
    variantId:       node.id,
    sku:             node.sku,
    inventoryItemId: node.inventoryItem.id,
  }));

  return {
    id:             product.id,
    title:          product.title,
    handle:         product.handle,
    inventoryItems,
  };
}

/**
 * Step 2: Attach Etsy images to the product.
 * Non-fatal on partial failure — logs warnings and continues.
 *
 * @param {string}   productId - GID from Step 1
 * @param {object[]} images    - payload._images array
 * @returns {{ mediaCount: number }}
 */
async function stepAttachMedia(productId, images) {
  if (images.length === 0) return { mediaCount: 0 };

  const variables = buildMediaVariables(productId, images);
  const result    = await shopifyGql(PRODUCT_CREATE_MEDIA_MUTATION, variables);

  if (result.errors?.length > 0) {
    console.warn(`  [WARN] productCreateMedia network error: ${result.errors[0].message}`);
    return { mediaCount: 0 };
  }

  const pcm = result.data?.productCreateMedia;
  if (pcm?.mediaUserErrors?.length > 0) {
    const msgs = pcm.mediaUserErrors.map(e => `${e.field}: ${e.message}`).join('; ');
    console.warn(`  [WARN] productCreateMedia errors: ${msgs}`);
  }

  return { mediaCount: pcm?.media?.length ?? 0 };
}

/**
 * Step 3: Set on-hand inventory for every variant at the fulfilment location.
 * Batched to ≤100 items per API call to respect Shopify input limits.
 *
 * @param {object[]} inventoryItems - [{inventoryItemId, sku}] from Step 1
 * @param {string}   locationId     - GID from resolveLocationId()
 * @param {number}   qty            - stock quantity
 * @returns {{ itemsSet: number }}
 */
async function stepSetInventory(inventoryItems, locationId, qty) {
  if (inventoryItems.length === 0) return { itemsSet: 0 };

  const BATCH_SIZE = 100;
  let totalSet     = 0;

  for (let i = 0; i < inventoryItems.length; i += BATCH_SIZE) {
    const batch           = inventoryItems.slice(i, i + BATCH_SIZE);
    // Generate a unique UUID per batch — required by @idempotent in Shopify API 2026-04+
    const idempotencyKey  = crypto.randomUUID();
    const variables       = buildInventoryVariables(batch, locationId, qty, idempotencyKey);
    const result          = await shopifyGql(INVENTORY_SET_MUTATION, variables);

    if (result.errors?.length > 0) {
      throw new Error(`inventorySetOnHandQuantities: ${result.errors[0].message}`);
    }

    const inv = result.data?.inventorySetOnHandQuantities;
    if (inv?.userErrors?.length > 0) {
      const msgs = inv.userErrors.map(e => `[${e.field}] ${e.message}`).join('; ');
      throw new Error(`inventorySetOnHandQuantities userErrors: ${msgs}`);
    }

    totalSet += batch.length;
  }

  return { itemsSet: totalSet };
}

/**
 * Step 4: Set taxonomy attribute metafields via metafieldsSet.
 * Non-fatal — taxonomy metadata NEVER blocks product creation.
 *
 * Why metafieldsSet instead of productSet inline:
 *   The `shopify` namespace is Shopify-reserved.  productSet rejects
 *   shopify-namespace MetafieldInput entries (INVALID_METAFIELD) because the
 *   app does not own those definitions.  metafieldsSet accepts them once the
 *   product exists and Shopify has materialised the category's attribute
 *   definitions (happens synchronously during Step 1's productSet call).
 *
 * Retry behaviour:
 *   Up to MAX_RETRIES retries on hard network/GraphQL errors with exponential
 *   back-off.  userErrors (validation failures per attribute) are NOT retried
 *   — they indicate a data or schema mismatch that a retry would not fix.
 *   All failures are logged to console and surfaced in the SSE stream as
 *   warnings; they never throw.
 *
 * @param {string}   productId  - GID from Step 1
 * @param {object[]} metafields - shopify-namespace MetafieldInput objects
 * @returns {{ metafieldsSet: number, warnings: string[] }}
 */
async function stepSetTaxonomyMetafields(productId, metafields) {
  if (metafields.length === 0) return { metafieldsSet: 0, warnings: [] };

  const MAX_RETRIES    = 2;
  const BASE_DELAY_MS  = 1_500;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    const variables = buildTaxonomyMetafieldsVariables(productId, metafields);

    let result;
    try {
      result = await shopifyGql(METAFIELDS_SET_MUTATION, variables);
    } catch (fetchErr) {
      // shopifyGql exhausted its own retries and re-threw (persistent network failure).
      // Treat as a retryable hard error within our own loop.
      const msg = fetchErr.message;
      if (attempt <= MAX_RETRIES) {
        const delay = BASE_DELAY_MS * attempt;
        console.warn(`  [WARN] metafieldsSet attempt ${attempt}/${MAX_RETRIES + 1} threw: ${msg}. Retrying in ${delay}ms…`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      const warn = `metafieldsSet threw after ${attempt} attempts: ${msg}`;
      console.warn(`  [WARN] ${warn}`);
      return { metafieldsSet: 0, warnings: [warn] };
    }

    // Hard transport / GraphQL error in the response body — retry with back-off
    if (result.errors?.length > 0) {
      const msg = result.errors.map(e => e.message).join('; ');
      if (attempt <= MAX_RETRIES) {
        const delay = BASE_DELAY_MS * attempt;
        console.warn(`  [WARN] metafieldsSet attempt ${attempt}/${MAX_RETRIES + 1} failed: ${msg}. Retrying in ${delay}ms…`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      const warn = `metafieldsSet network error after ${attempt} attempts: ${msg}`;
      console.warn(`  [WARN] ${warn}`);
      return { metafieldsSet: 0, warnings: [warn] };
    }

    const ms         = result.data?.metafieldsSet;
    const userErrors = ms?.userErrors ?? [];
    const setCount   = ms?.metafields?.length ?? 0;

    if (userErrors.length > 0) {
      // Shopify's MetafieldsSetUserError.field is [String!] — an array such as
      // ["metafields","2","value"], NOT a dot-bracket string like "metafields[2].value".
      // Find the numeric segment to map back to the metafield key.
      const warnings = userErrors.map(e => {
        const parts    = Array.isArray(e.field) ? e.field : (e.field ? [String(e.field)] : []);
        const numPart  = parts.find(p => /^\d+$/.test(p));
        const key      = numPart != null
          ? (metafields[parseInt(numPart, 10)]?.key ?? parts.join('.'))
          : (parts.join('.') || 'unknown');
        return `[${e.code ?? '?'}] shopify.${key}: ${e.message}`;
      });
      console.warn(`  [WARN] metafieldsSet taxonomy partial errors (${setCount}/${metafields.length} set):\n    ${warnings.join('\n    ')}`);
      return { metafieldsSet: setCount, warnings };
    }

    // Full success
    return { metafieldsSet: setCount, warnings: [] };
  }

  const warn = `metafieldsSet gave up after ${MAX_RETRIES + 1} attempts`;
  console.warn(`  [WARN] ${warn}`);
  return { metafieldsSet: 0, warnings: [warn] };
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

// Minimum milliseconds between products to stay under GraphQL cost budget.
//
// Math:  ~235 query-cost points per product (productSet ≈ 150 + media ≈ 15 + inventory ≈ 72)
//        Bucket: 1000 pts, restore: 50 pts/s
//        To be sustainable forever: need 235 pts restored per product interval
//        → 235 / 50 = 4.7s minimum. Using 5.5s for 17% headroom.
const MIN_PRODUCT_INTERVAL_MS = 5_500;

/**
 * Load a single transformed product into Shopify.
 * Executes Steps 1-3 in sequence, then enforces the minimum inter-product delay.
 *
 * @param {object} payload    - output of buildShopifyPayload() from transform.mjs
 * @param {string} locationId - GID from resolveLocationId()
 * @param {object} [options]
 * @param {boolean}  [options.dryRun=false]       - if true, return payloads without calling API
 * @param {boolean}  [options.skipExisting=true]  - skip products whose handle already exists
 * @param {Function} [options.onProgress=null]    - optional event callback for SSE streaming.
 *   Called with { type, step?, ... } after each step completes:
 *     { type:'skipped', reason }
 *     { type:'step', step:'productSet',        productId, variantCount }
 *     { type:'step', step:'media',             mediaCount }
 *     { type:'step', step:'inventory',         itemsSet }
 * @returns {Promise<LoadResult>}
 *
 * @typedef {object} LoadResult
 * @property {'created'|'skipped'|'dry-run'} status
 * @property {string}  [productId]
 * @property {string}  title
 * @property {string}  handle
 * @property {number}  [variantCount]
 * @property {number}  [mediaCount]
 * @property {number}  [inventoryItemsSet]
 * @property {object}  [dryRunPayloads]  - only present in dry-run mode
 */
export async function loadProduct(payload, locationId, { dryRun = false, skipExisting = true, onProgress = null } = {}) {
  const emit = (event) => { try { onProgress?.(event); } catch { /* never crash on SSE error */ } };
  const startMs = Date.now();

  // ── Dry-run: return payloads without touching the API ──────────────────────
  if (dryRun) {
    return {
      status: 'dry-run',
      title:  payload.title,
      handle: payload.handle,
      dryRunPayloads: {
        step1_productSet: {
          mutation:  PRODUCT_SET_MUTATION.trim(),
          variables: buildProductSetVariables(payload),
        },
        step2_productCreateMedia: {
          mutation:  PRODUCT_CREATE_MEDIA_MUTATION.trim(),
          variables: buildMediaVariables(
            'gid://shopify/Product/<id from Step 1>',
            payload._images
          ),
        },
        step3_inventorySetOnHandQuantities: {
          mutation:  INVENTORY_SET_MUTATION.trim(),
          variables: buildInventoryVariables(
            payload.variants.map((v, i) => ({
              inventoryItemId: `gid://shopify/InventoryItem/<variant_${i + 1}_id from Step 1>`,
              sku:             v.sku,
            })),
            locationId,
            payload._inventoryQty,
            '<unique-uuid-per-call>'
          ),
        },
        // Step 4 (metafieldsSet for standard taxonomy attributes) is omitted from
        // dry-run output because it requires the product's GID from Step 1.
        // After a real import, loader.mjs auto-sets: material, theme,
        // attachment-options, connectivity-technology — IF the Metaobject GID
        // cache exists (.cache/taxonomy-metaobj-gid-cache.json).
        // Bootstrap once: set any Category metafield in Admin, then run:
        //   node scripts/lib/discover-metaobj-gids.mjs
        // Other category attributes (case-type, magsafe-compatibility, finish, …)
        // must be set manually in Shopify Admin → Product → Category metafields.
      },
    };
  }

  // ── Existing product check ─────────────────────────────────────────────────
  // Always look up the handle in Shopify:
  //   skipExisting=true  → skip if found (NEW product safety guard)
  //   skipExisting=false → capture the ID for a proper upsert (CONFLICT / MATCH)
  let existingId = null;
  const existing = await findProductByHandle(payload.handle);
  if (existing) {
    if (skipExisting) {
      emit({ type: 'skipped', reason: 'handle already exists in Shopify' });
      return {
        status:    'skipped',
        title:     payload.title,
        handle:    payload.handle,
        productId: existing.id,
      };
    }
    existingId = existing.id;
  }

  // ── Step 1: Create / update product ────────────────────────────────────────
  const created = await stepCreateProduct(payload, existingId);
  emit({ type: 'step', step: 'productSet', productId: created.id, variantCount: created.inventoryItems.length });

  // ── Step 2: Attach images ─────────────────────────────────────────────────
  const { mediaCount } = await stepAttachMedia(created.id, payload._images);
  emit({ type: 'step', step: 'media', mediaCount });

  // ── Step 3: Set inventory ─────────────────────────────────────────────────
  const { itemsSet } = await stepSetInventory(
    created.inventoryItems,
    locationId,
    payload._inventoryQty
  );
  emit({ type: 'step', step: 'inventory', itemsSet });

  // ── Step 4: Set standard taxonomy attribute metafields ────────────────────
  // Converts the payload's TaxonomyValue GIDs to Metaobject GIDs (using the
  // cache built by discover-metaobj-gids.mjs) and calls metafieldsSet for the
  // 4 standard-definition attributes: material, theme, attachment-options,
  // connectivity-technology.
  //
  // Only runs when .cache/taxonomy-metaobj-gid-cache.json exists (bootstrap
  // done). Falls through silently if cache is missing.
  //
  // The remaining Category metafields (case-type, magsafe-compatibility, etc.)
  // return APP_NOT_AUTHORIZED and must be set manually in Shopify Admin.
  const shopifyMfs = (payload.metafields ?? []).filter(mf => mf.namespace === 'shopify');
  const stdMfs     = buildStandardAttrMetafields(shopifyMfs);
  if (stdMfs.length > 0) {
    const { metafieldsSet: mfsSet, warnings } = await stepSetTaxonomyMetafields(created.id, stdMfs);
    emit({ type: 'step', step: 'taxonomyMetafields', metafieldsSet: mfsSet, warnings });
  }

  // ── Enforce minimum inter-product interval ─────────────────────────────────
  const elapsed = Date.now() - startMs;
  if (elapsed < MIN_PRODUCT_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, MIN_PRODUCT_INTERVAL_MS - elapsed));
  }

  return {
    status:            existingId ? 'updated' : 'created',
    productId:         created.id,
    title:             created.title,
    handle:            created.handle,
    variantCount:      created.inventoryItems.length,
    mediaCount,
    inventoryItemsSet: itemsSet,
  };
}
