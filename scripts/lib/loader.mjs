/**
 * Y2KASE Phase 4 — Load Layer
 *
 * Orchestrates the three-mutation sequence required to fully create a product
 * in Shopify from a transformed payload:
 *
 *   Step 1 — productSet
 *     Creates the product record with all options, 72 variants, SEO fields,
 *     and custom metafields in a single atomic GraphQL call.
 *     Returns: productId + inventoryItemId per variant.
 *
 *   Step 2 — productCreateMedia
 *     Attaches Etsy image URLs to the created product.
 *     Called separately because ProductSetInput does not accept media.
 *
 *   Step 3 — inventorySetOnHandQuantities
 *     Sets the on-hand stock quantity for every variant at the resolved
 *     fulfilment location. Batched to 100 items per call if needed.
 *
 * All API calls are routed through shopifyGql() in shopify-client.mjs,
 * which provides rate limiting and retry logic — this module stays pure.
 */

import { shopifyGql, findProductByHandle } from '../shopify-client.mjs';

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

// ── Variable builders ─────────────────────────────────────────────────────────

/**
 * Build the variables object for the productSet mutation.
 * Strips pipeline-internal _ fields before sending to the API.
 *
 * Fields explicitly included:
 *   Core:            title, descriptionHtml, handle, vendor, productType, status
 *   Taxonomy:        productCategory  ← required to set the Shopify product category
 *   Collections:     collectionsToJoin ← required to assign auto-detected collections
 *   Discovery:       tags, seo, metafields
 *   Variant matrix:  productOptions, variants
 *
 * @param {object} payload - output of buildShopifyPayload() from transform.mjs
 * @returns {{ synchronous: boolean, input: object }}
 */
export function buildProductSetVariables(payload, existingId = null) {
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
    metafields:      payload.metafields,
    productOptions:  payload.productOptions,
    variants:        payload.variants,
  };

  // Shopify Standard Product Category — API 2024-10+ renamed the input field
  // from productCategory.productTaxonomyNodeId to a flat `category` ID scalar.
  // Pass the GID directly; omitting it leaves the category blank in Admin.
  const categoryId = payload.productCategory?.productTaxonomyNodeId
    ?? (typeof payload.productCategory === 'string' ? payload.productCategory : null);
  if (categoryId) {
    input.category = categoryId;
  }

  // Collection membership — API 2024-10+ renamed collectionsToJoin → collections.
  // `collections` is a list field: on UPDATE it REPLACES existing memberships,
  // so only include it for brand-new products to avoid wiping manual overrides.
  if (!existingId && Array.isArray(payload.collectionsToJoin) && payload.collectionsToJoin.length > 0) {
    input.collections = payload.collectionsToJoin;
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
 *     { type:'step', step:'productSet',  productId, variantCount }
 *     { type:'step', step:'media',       mediaCount }
 *     { type:'step', step:'inventory',   itemsSet }
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
