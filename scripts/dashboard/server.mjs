/**
 * Y2KASE Import Dashboard — Express Server  (Phase 3)
 *
 * Routes:
 *   GET  /                      → index.html
 *   GET  /api/preflight         → token ping + CSV row count + live location GID
 *   GET  /api/preview           → CSV parse → transform → Shopify diff (NEW/CONFLICT/MATCH)
 *   GET  /api/import/stream     → SSE: productSet → media → inventory per handle
 *   POST /api/token/refresh     → client_credentials OAuth → writes new token to .env
 *   GET  /api/history           → import-history.json entries
 *   GET  /api/product/:handle   → full transformed payload + live Shopify data
 */

import express              from 'express';
import { createServer }     from 'node:http';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { readFile, writeFile }  from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath }    from 'node:url';
import open                 from 'open';

import { parseCsvFile }        from '../lib/csv-parser.mjs';
import { normalizeEtsyRecord } from '../lib/normalize.mjs';
import { buildShopifyPayload } from '../lib/transform.mjs';
import { enrichProductStyles } from '../lib/llm-enrich.mjs';
import { loadProduct }         from '../lib/loader.mjs';
import { shopifyGql, resolveLocationId } from '../shopify-client.mjs';
import { isTaxonomyCachePopulated, taxonomyCacheFetchedAt, resolveCategoryMetafieldsForDisplay } from '../lib/category-metafields.mjs';

// ── Paths ─────────────────────────────────────────────────────────────────────
const __dirname    = dirname(fileURLToPath(import.meta.url));
const ROOT         = resolve(__dirname, '../..');
const PUBLIC_DIR   = join(__dirname, 'public');
const ENV_PATH     = resolve(ROOT, '.env');
const CSV_PATH     = resolve(ROOT, 'data/EtsyListingsDownload.csv');
const HISTORY_PATH = resolve(ROOT, 'data/import-history.json');

const PORT          = 3000;
const LOCATION_NAME = 'FLAT D 10/F BLOCK 6 LILY MANSION';

// ── .env loader ───────────────────────────────────────────────────────────────
// shopify-client.mjs also calls loadEnv() at module-init time, so tokens are
// available before any route runs.  This copy keeps server-side vars in sync
// after a POST /api/token/refresh updates the file.
function loadEnv() {
  try {
    const lines = readFileSync(ENV_PATH, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      process.env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  } catch { /* rely on real env */ }
}
loadEnv();

const STORE   = process.env.SHOPIFY_SHOP?.trim();
const VERSION = process.env.SHOPIFY_API_VERSION || '2026-04';

// ── Token validator (lightweight ping for preflight) ──────────────────────────
async function checkToken() {
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN?.trim();
  if (!token) return { ok: false, reason: 'SHOPIFY_ADMIN_ACCESS_TOKEN not set in .env' };
  if (!STORE)  return { ok: false, reason: 'SHOPIFY_SHOP not set in .env' };
  try {
    const res = await fetch(`https://${STORE}/admin/api/${VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query: '{ shop { name } }' }),
    });
    if (res.status === 401) return { ok: false, reason: 'Token invalid or expired (401)' };
    if (!res.ok)            return { ok: false, reason: `Shopify API error: HTTP ${res.status}` };
    const json = await res.json();
    if (json.errors)        return { ok: false, reason: json.errors[0]?.message ?? 'GraphQL error' };
    return { ok: true, shop: json.data?.shop?.name };
  } catch (err) {
    return { ok: false, reason: `Network error: ${err.message}` };
  }
}

// ── Preview cache ─────────────────────────────────────────────────────────────
// Populated by GET /api/preview.  Re-used by GET /api/import/stream to avoid
// re-parsing the CSV on every import trigger.
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let _cache = null;   // { results: AuditRow[], payloadMap: Map<handle,payload>, ts: number }
let _building = false;

// ── Shopify batch product query ───────────────────────────────────────────────
// Fetches up to BATCH_SIZE products per GraphQL call using field aliases so we
// only need ceil(n / BATCH_SIZE) round-trips instead of n individual queries.

const BATCH_SIZE = 10;

const PRODUCT_FIELDS = `
  id
  title
  status
  productType
  tags
  productCategory {
    productTaxonomyNode {
      id
      name
      fullName
    }
  }
  variants(first: 250) { edges { node { price } } }
  media(first: 50)     { edges { node { id }    } }
`;

async function fetchShopifyProducts(handles) {
  const map = new Map();
  if (!handles.length) return map;

  for (let i = 0; i < handles.length; i += BATCH_SIZE) {
    const batch = handles.slice(i, i + BATCH_SIZE);

    const aliases = batch
      .map((h, j) =>
        `p${j}: productByIdentifier(identifier: { handle: ${JSON.stringify(h)} }) { ${PRODUCT_FIELDS} }`
      )
      .join('\n');

    let resp;
    try {
      resp = await shopifyGql(`query { ${aliases} }`);
    } catch (err) {
      console.warn(`[preview] Shopify batch query failed (batch ${i / BATCH_SIZE + 1}): ${err.message}`);
      batch.forEach(h => map.set(h, null));
      continue;
    }

    for (let j = 0; j < batch.length; j++) {
      map.set(batch[j], resp.data?.[`p${j}`] ?? null);
    }
  }

  return map;
}

// ── Diff engine ───────────────────────────────────────────────────────────────
// Compares a transformed Etsy payload against the live Shopify product.
// Returns NEW / CONFLICT / MATCH + field-level diff array.

function computeDiff(payload, shopifyProduct) {
  const etsyPrices = payload.variants.map(v => parseFloat(v.price));

  // Normalise the taxonomy node ID: payload stores it as a full GID string;
  // Shopify returns it back as a full GID — compare them directly.
  const etsyCategory = payload.productCategory?.productTaxonomyNodeId ?? null;

  const etsySide = {
    title:           payload.title,
    variantCount:    payload.variants.length,
    priceRange:      `${Math.min(...etsyPrices).toFixed(2)}–${Math.max(...etsyPrices).toFixed(2)}`,
    imageCount:      payload._images.length,
    productType:     payload.productType,
    status:          'DRAFT',
    productCategory: etsyCategory,
  };

  if (!shopifyProduct) {
    return { status: 'new', etsy: etsySide, shopify: null, diffs: [] };
  }

  const spPrices        = shopifyProduct.variants.edges.map(e => parseFloat(e.node.price));
  const shopifyCategory = shopifyProduct.productCategory?.productTaxonomyNode?.id ?? null;

  const shopifySide = {
    title:           shopifyProduct.title,
    variantCount:    shopifyProduct.variants.edges.length,
    priceRange:      spPrices.length
      ? `${Math.min(...spPrices).toFixed(2)}–${Math.max(...spPrices).toFixed(2)}`
      : '—',
    imageCount:      shopifyProduct.media.edges.length,
    productType:     shopifyProduct.productType ?? '',
    status:          shopifyProduct.status,
    productCategory: shopifyCategory,
    // Expose the human-readable category name for the dashboard diff pane
    _categoryName:   shopifyProduct.productCategory?.productTaxonomyNode?.name ?? null,
  };

  const diffs = [];
  const cmp = (field, a, b) => { if (String(a ?? '') !== String(b ?? '')) diffs.push({ field, etsy: a, shopify: b }); };

  cmp('title',           etsySide.title,           shopifySide.title);
  cmp('variantCount',    etsySide.variantCount,     shopifySide.variantCount);
  cmp('priceRange',      etsySide.priceRange,       shopifySide.priceRange);
  cmp('imageCount',      etsySide.imageCount,       shopifySide.imageCount);
  cmp('productType',     etsySide.productType,      shopifySide.productType);
  cmp('productCategory', etsySide.productCategory,  shopifySide.productCategory);

  return {
    status:  diffs.length === 0 ? 'match' : 'conflict',
    etsy:    etsySide,
    shopify: shopifySide,
    diffs,
  };
}

// ── Preview builder ───────────────────────────────────────────────────────────
// Full ETL + idempotency check.  Results are cached for CACHE_TTL_MS.

async function buildPreview() {
  // Return cached data if still fresh
  if (_cache && Date.now() - _cache.ts < CACHE_TTL_MS) return _cache;

  // Simple lock — prevents duplicate builds from concurrent requests
  if (_building) {
    while (_building) await new Promise(r => setTimeout(r, 80));
    return _cache;
  }
  _building = true;

  try {
    // ── 1. Parse CSV → normalise (sync) ──────────────────────────────────────
    const rawProducts = [];   // all EtsyProduct objects in CSV order
    for await (const raw of parseCsvFile(CSV_PATH)) {
      const etsy = normalizeEtsyRecord(raw);
      if (!etsy.title) continue;
      rawProducts.push(etsy);
    }

    // ── 1b. LLM style extraction — gpt-5.4-mini reads every product description
    //        and returns the exact bundle styles offered.  Results are cached to
    //        disk by description hash so re-runs never re-call the API.
    loadEnv(); // re-read .env so OPENAI_MODEL picks up any in-session changes
    const openaiKey   = process.env.OPENAI_API_KEY?.trim();
    const openaiModel = process.env.OPENAI_MODEL?.trim() || 'gpt-5.4-mini';
    const enriched   = await enrichProductStyles(rawProducts, openaiKey, openaiModel);

    // Apply enrichment results back onto the product objects (non-mutating copy).
    // patch = { stylesFromDescription: string[], components: {hasGrip,hasCharm,hasStrap} }
    const products = rawProducts.map(p => {
      const patch = enriched.get(p.title);
      return patch ? { ...p, stylesFromDescription: patch.stylesFromDescription, _components: patch.components } : p;
    });

    // ── 1c. Transform enriched products → Shopify payloads ───────────────────
    const payloadMap  = new Map();     // handle → full payload (needed by stream route)
    const handleCount = new Map();     // base handle → number of times seen (for suffix)
    const ordered     = [];            // [{ handle, payload, etsySku }] in CSV order

    for (const etsy of products) {
      // Title is the only hard requirement — missing models/styles are handled
      // by resolveVariations() (smart fallbacks) inside buildShopifyPayload().
      let payload;
      try {
        payload = buildShopifyPayload(etsy);
      } catch (err) {
        console.warn(`[preview] transform failed: "${etsy.title.slice(0, 50)}" — ${err.message}`);
        continue;
      }

      // Skip products that ended up with zero variants even after fallbacks
      if (!payload.variants.length) continue;

      // When multiple Etsy listings generate the same clean Shopify handle
      // (e.g. "monchhichi-clear-iphone-case-with-charm-kawaii"), append a
      // numeric suffix (-2, -3 …) so every product gets a unique handle
      // and none are silently dropped.
      const baseHandle = payload.handle;
      const count = handleCount.get(baseHandle) ?? 0;
      handleCount.set(baseHandle, count + 1);

      const uniqueHandle = count === 0 ? baseHandle : `${baseHandle}-${count + 1}`;
      if (uniqueHandle !== baseHandle) {
        payload = { ...payload, handle: uniqueHandle };
        console.info(
          `[preview] handle collision resolved: "${baseHandle}" → "${uniqueHandle}" ` +
          `(title: "${etsy.title.slice(0, 50)}…")`
        );
      }

      payloadMap.set(uniqueHandle, payload);
      // Preserve raw etsy fields alongside payload for preview enrichment
      ordered.push({ handle: uniqueHandle, payload, etsySku: etsy.etsySku, etsy });
    }

    // ── 2. Batch-check Shopify for existing products ──────────────────────────
    const handles    = ordered.map(o => o.handle);
    const shopifyMap = await fetchShopifyProducts(handles);

    // ── 3. Compute diff for each product ─────────────────────────────────────
    const results = ordered.map(({ handle, payload, etsySku, etsy }) => {
      const shopifyProduct = shopifyMap.get(handle) ?? null;
      const diff           = computeDiff(payload, shopifyProduct);
      const etsyPrices     = payload.variants.map(v => parseFloat(v.price));

      // Derive actual option counts + style names from the transformed payload.
      // These are post-LLM-enrichment values and are more accurate than the raw
      // CSV VARIATION counts (which always export all 6 options regardless of
      // what the product actually sells, and don't reflect model fallbacks).
      const modelOptions = (payload.productOptions?.find(o => o.name === 'Phone Model')?.values ?? []).map(v => v.name);
      const styleOptions = (payload.productOptions?.find(o => o.name === 'Style')?.values ?? []).map(v => v.name);

      return {
        status:       diff.status,          // 'new' | 'conflict' | 'match'
        handle,
        title:        payload.title,
        etsySku:      etsySku || null,
        variantCount:     payload.variants.length,  // dynamic: models × styles
        modelCount:       modelOptions.length,       // actual derived model count
        styleCount:       styleOptions.length,       // actual derived style count
        styleOptions,                                // e.g. ['Case+Grip+Charm', 'Case+Grip', …]
        fallbacksApplied: payload._meta.fallbacksApplied ?? null,
        bodyHtml:         payload.bodyHtml,
        // Auto-assigned collection objects [{gid,label,level,handle,key}].
        // Rendered in the After Pane as read-only chips.
        collections:      payload._meta.collections ?? [],
        // Merged tag array (classifier prefixed + collection-logic supplementary).
        // Exposed here so the After Pane's Tags field is pre-populated.
        tags:             payload.tags ?? [],
        imageCount:   payload._images.length,
        priceMin:     Math.min(...etsyPrices),
        priceMax:     Math.max(...etsyPrices),
        // Enriched fields for thumbnail column and Before/After inspector
        imageUrl:     payload._images[0]?.src ?? null,
        etsyTitle:    payload._meta.etsyTitle,
        collection:   payload.productType,
        sampleSku:    payload.variants[0]?.sku ?? null,
        etsyModels:   etsy.models,
        etsyStyles:   etsy.styles,
        etsyTags:     etsy.tags,
        etsy:         diff.etsy,
        shopify:      diff.shopify,
        diffs:        diff.diffs,
        shopifyId:    shopifyProduct?.id ?? null,
        // Shopify taxonomy category — expose as plain GID string for the UI input.
        // The payload stores it as { productTaxonomyNodeId: '...' }; we unwrap
        // it here so the Category field doesn't show "[object Object]".
        productCategory: payload.productCategory?.productTaxonomyNodeId
          ?? (typeof payload.productCategory === 'string' ? payload.productCategory : null),

        // Resolved category metafields — human-readable for the dashboard inspector.
        // Shape: [{ key, name, values: string[] }]
        // Empty array means the pipeline produced no metafields for this product.
        categoryMetafields: resolveCategoryMetafieldsForDisplay(payload.metafields ?? []),
      };
    });

    _cache = { results, payloadMap, ts: Date.now() };
    return _cache;

  } finally {
    _building = false;
  }
}

// ── History helpers ───────────────────────────────────────────────────────────

async function appendToHistory(entry) {
  let history = [];
  try {
    if (existsSync(HISTORY_PATH)) {
      history = JSON.parse(await readFile(HISTORY_PATH, 'utf-8'));
      if (!Array.isArray(history)) history = [];
    }
  } catch { history = []; }

  history.unshift(entry);                        // newest first
  if (history.length > 100) history.length = 100; // cap

  await writeFile(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf-8');
}

// ── SSE helper ────────────────────────────────────────────────────────────────

function sseWrite(res, data) {
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

// ── Express setup ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE: GET /
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'index.html')));

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE: GET /api/preflight
// Three independent checks: token (live ping), CSV (file + row count),
// location (resolveLocationId returns cached GID on subsequent calls).
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/preflight', async (_req, res) => {
  const [tokenResult] = await Promise.all([checkToken()]);

  // CSV
  const csvExists = existsSync(CSV_PATH);
  let csvRows = 0;
  if (csvExists) {
    try {
      const text = readFileSync(CSV_PATH, 'utf-8');
      csvRows = Math.max(0, text.split('\n').filter(l => l.trim()).length - 1);
    } catch { /* ignore */ }
  }

  // Location — only attempt if token is valid (avoids a 401 noise)
  let locationId   = null;
  let locationOk   = false;
  let locationNote = null;
  if (tokenResult.ok) {
    try {
      locationId  = await resolveLocationId(LOCATION_NAME);
      locationOk  = true;
    } catch (err) {
      locationNote = err.message;
    }
  } else {
    locationNote = 'Skipped — token not valid';
  }

  res.json({
    token: {
      ok:     tokenResult.ok,
      reason: tokenResult.reason ?? null,
      shop:   tokenResult.shop   ?? null,
    },
    csv: {
      ok:     csvExists,
      path:   CSV_PATH,
      rows:   csvRows,
      reason: csvExists ? null : `File not found: ${CSV_PATH}`,
    },
    location: {
      ok:     locationOk,
      name:   LOCATION_NAME,
      id:     locationId,
      reason: locationNote,
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE: GET /api/preview
// Full ETL diff:
//   1. Stream-parse CSV → normalise → transform (all products, deduped by handle)
//   2. Batch-query Shopify for existing products (BATCH_SIZE aliases per GQL call)
//   3. Compute NEW / CONFLICT / MATCH for each product
// Results are cached for CACHE_TTL_MS to avoid re-running on every request.
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/preview', async (_req, res) => {
  try {
    const { results } = await buildPreview();
    res.json(results);
  } catch (err) {
    console.error('[preview] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE: GET /api/import/stream
//
// Server-Sent Events (SSE) import pipeline.
//
// Query params:
//   ?handles=handle-1,handle-2,...   comma-separated list to import
//
// SSE event types streamed to client:
//   { type:'start',        total }
//   { type:'product_start',index, total, handle, title }
//   { type:'step',         index, handle, step:'productSet'|'media'|'inventory', ...stepData }
//   { type:'product_done', index, total, handle, status:'created'|'skipped', ...result }
//   { type:'error',        index, handle, msg }
//   { type:'log',          level:'info'|'success'|'warn', msg }
//   { type:'done',         summary: { created, skipped, errors } }
//
// Rate-limiting:
//   loadProduct() enforces MIN_PRODUCT_INTERVAL_MS = 5 500 ms internally.
//   The heartbeat comment (`: heartbeat`) fires every 10 s to prevent proxies
//   and browsers from closing an idle SSE connection during that wait window.
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/import/stream', async (req, res) => {
  // ── SSE headers — must be set and flushed before any await ─────────────────
  res.set({
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',         // disable Nginx/proxy buffering
  });
  res.flushHeaders();

  const emit = (data) => sseWrite(res, data);

  // Heartbeat keeps the TCP connection alive during the 5.5 s inter-product
  // rate-limit pause.  The ': comment' format is valid SSE but is NOT
  // dispatched as a 'message' event — it's invisible to the EventSource listener.
  let closed = false;
  const hb   = setInterval(() => { if (!closed && !res.writableEnded) res.write(': heartbeat\n\n'); }, 10_000);
  req.on('close', () => { closed = true; clearInterval(hb); });

  const handles = (req.query.handles ?? '').split(',').map(h => h.trim()).filter(Boolean);

  if (!handles.length) {
    emit({ type: 'fatal', msg: 'No handles provided. Pass ?handles=handle-1,handle-2,...' });
    res.end();
    return;
  }

  const summary = { created: 0, skipped: 0, errors: 0, startedAt: new Date().toISOString() };

  try {
    // ── Resolve location (cached after first call) ────────────────────────────
    emit({ type: 'log', level: 'info', msg: 'Resolving fulfillment location…' });
    const locationId = await resolveLocationId(LOCATION_NAME);
    emit({ type: 'log', level: 'success', msg: `Location resolved: ${locationId.split('/').pop()}` });

    // ── Build payload map ─────────────────────────────────────────────────────
    // Prefer the in-memory preview cache (already built during /api/preview).
    // If stale or absent, rebuild only the requested handles from the CSV.
    emit({ type: 'log', level: 'info', msg: `Building payloads for ${handles.length} product(s)…` });

    let payloadMap;
    if (_cache && Date.now() - _cache.ts < CACHE_TTL_MS) {
      payloadMap = _cache.payloadMap;
    } else {
      // Selective re-parse: stop as soon as all requested handles are found
      payloadMap = new Map();
      const needed = new Set(handles);
      for await (const raw of parseCsvFile(CSV_PATH)) {
        if (closed) break;
        const etsy = normalizeEtsyRecord(raw);
        if (!etsy.title) continue; // fallbacks handle missing models/styles
        try {
          const payload = buildShopifyPayload(etsy);
          if (!payload.variants.length) continue; // nothing to import
          if (needed.has(payload.handle) && !payloadMap.has(payload.handle)) {
            payloadMap.set(payload.handle, payload);
            if (payloadMap.size === needed.size) break; // early exit
          }
        } catch { /* skip malformed rows */ }
      }
    }

    // ── Import loop ────────────────────────────────────────────────────────────
    emit({ type: 'start', total: handles.length });

    for (let i = 0; i < handles.length; i++) {
      if (closed) { emit({ type: 'log', level: 'warn', msg: 'Client disconnected — import aborted.' }); break; }

      const handle  = handles[i];
      const payload = payloadMap.get(handle);
      const idx     = i + 1;

      if (!payload) {
        emit({ type: 'error', index: idx, total: handles.length, handle,
               msg: `Handle "${handle}" not found in CSV — skipping.` });
        summary.errors++;
        continue;
      }

      emit({ type: 'product_start', index: idx, total: handles.length, handle, title: payload.title });

      // CONFLICT and MATCH products already exist in Shopify — bypass the skip
      // check so productSet runs as an upsert.  The loader will look up the
      // existing product ID and pass it in the mutation input for a true update.
      // NEW products (and handles missing from cache) use skipExisting=true so
      // the existence check still runs as a safety guard before creation.
      const cachedStatus = _cache?.results?.find(r => r.handle === handle)?.status;
      const skipExisting = cachedStatus !== 'conflict' && cachedStatus !== 'match';

      try {
        const result = await loadProduct(payload, locationId, {
          dryRun: false,
          skipExisting,
          onProgress: (event) => {
            // Relay each step event back to the SSE stream
            emit({ ...event, index: idx, total: handles.length, handle });
          },
        });

        emit({ type: 'product_done', index: idx, total: handles.length, handle,
               status: result.status, variantCount: result.variantCount ?? null,
               mediaCount: result.mediaCount ?? null, productId: result.productId ?? null });

        summary[result.status === 'created' || result.status === 'updated' ? 'created' : 'skipped']++;

      } catch (err) {
        emit({ type: 'error', index: idx, total: handles.length, handle, msg: err.message });
        summary.errors++;
      }
    }

    // ── Write history entry ────────────────────────────────────────────────────
    const entry = {
      runId:     `run-${Date.now().toString(36)}`,
      timestamp: new Date().toISOString(),
      handles,
      ...summary,
      completedAt: new Date().toISOString(),
      durationMs:  Date.now() - new Date(summary.startedAt).getTime(),
    };
    appendToHistory(entry).catch(err =>
      console.error('[history] write failed:', err.message)
    );

    // Invalidate preview cache so next load reflects the newly imported products
    _cache = null;

    emit({ type: 'done', summary, runId: entry.runId });

  } catch (err) {
    console.error('[stream] fatal:', err.message);
    emit({ type: 'fatal', msg: err.message });
  } finally {
    clearInterval(hb);
    if (!res.writableEnded) res.end();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE: POST /api/token/refresh
// Re-exchanges client credentials for a fresh SHOPIFY_ADMIN_ACCESS_TOKEN and
// writes it back to .env.
// NOTE: shopify-client.mjs caches TOKEN at module-init time.  The new token
// takes effect for this server's API calls on the NEXT server start.
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/token/refresh', async (_req, res) => {
  const clientId     = process.env.SHOPIFY_CLIENT_ID?.trim();
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret || !STORE) {
    return res.status(400).json({
      ok: false,
      reason: 'SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, or SHOPIFY_SHOP missing in .env',
    });
  }

  try {
    const tokenRes = await fetch(`https://${STORE}/admin/oauth/access_token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
    });

    const text = await tokenRes.text();
    let data = {};
    try { data = JSON.parse(text); } catch { /* non-JSON */ }

    if (!data.access_token) {
      return res.status(502).json({ ok: false, reason: `Shopify returned HTTP ${tokenRes.status}: ${text.slice(0, 200)}` });
    }

    // Write new token to .env
    let env = readFileSync(ENV_PATH, 'utf-8');
    env = /^SHOPIFY_ADMIN_ACCESS_TOKEN=/m.test(env)
      ? env.replace(/^SHOPIFY_ADMIN_ACCESS_TOKEN=.*/m, `SHOPIFY_ADMIN_ACCESS_TOKEN=${data.access_token}`)
      : `${env.trimEnd()}\nSHOPIFY_ADMIN_ACCESS_TOKEN=${data.access_token}\n`;
    writeFileSync(ENV_PATH, env, 'utf-8');

    // Also update process.env for checkToken() (used by /api/preflight)
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = data.access_token;

    res.json({ ok: true, note: 'Token written to .env. Restart the server for Shopify API calls to use the new token.' });

  } catch (err) {
    res.status(500).json({ ok: false, reason: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE: GET /api/history
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/history', async (_req, res) => {
  try {
    if (!existsSync(HISTORY_PATH)) return res.json([]);
    const data = JSON.parse(await readFile(HISTORY_PATH, 'utf-8'));
    res.json(Array.isArray(data) ? data : []);
  } catch {
    res.json([]);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE: GET /api/product/:handle
// Returns:
//   { handle, etsy: <full transformed payload>, shopify: <live Shopify data> | null }
// Used by the Conflict Inspector modal to display the full diff.
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/product/:handle', async (req, res) => {
  const { handle } = req.params;

  // ── Find payload: check cache first, then re-parse CSV ─────────────────────
  let payload = _cache?.payloadMap?.get(handle) ?? null;

  if (!payload) {
    for await (const raw of parseCsvFile(CSV_PATH)) {
      const etsy = normalizeEtsyRecord(raw);
      if (!etsy.title) continue; // fallbacks handle missing models/styles
      try {
        const p = buildShopifyPayload(etsy);
        if (!p.variants.length) continue;
        if (p.handle === handle) { payload = p; break; }
      } catch { /* skip */ }
    }
  }

  if (!payload) {
    return res.status(404).json({ error: `Product "${handle}" not found in CSV.` });
  }

  // ── Fetch live Shopify data ────────────────────────────────────────────────
  const shopifyMap = await fetchShopifyProducts([handle]);
  const shopify    = shopifyMap.get(handle) ?? null;
  const diff       = computeDiff(payload, shopify);

  res.json({
    handle,
    status:  diff.status,
    diffs:   diff.diffs,
    etsy: {
      ...diff.etsy,
      metafields:   payload.metafields,
      tags:         payload.tags,
      seo:          payload.seo,
      variantSkus:  payload.variants.slice(0, 6).map(v => v.sku),   // first 6 for reference
    },
    shopify: shopify
      ? { ...diff.shopify, id: shopify.id, tags: shopify.tags }
      : null,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE: GET /api/product/:handle/variants
//
// Returns the complete, post-pruning variant list for a given handle sourced
// directly from the server-side preview cache (no Shopify API call).
// Used by the Variant Explorer in the Conflict Inspector modal.
//
// Response: { handle, count, variants: [{ model, style, sku, price }] }
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/product/:handle/variants', async (req, res) => {
  const { handle } = req.params;

  // Prefer the warm preview cache — avoids any CSV re-parse
  let payload = _cache?.payloadMap?.get(handle) ?? null;

  // Cold-cache fallback: selective re-parse until we find the handle
  if (!payload) {
    for await (const raw of parseCsvFile(CSV_PATH)) {
      const etsy = normalizeEtsyRecord(raw);
      if (!etsy.title) continue;
      try {
        const p = buildShopifyPayload(etsy);
        if (!p.variants.length) continue;
        if (p.handle === handle) { payload = p; break; }
      } catch { /* skip malformed rows */ }
    }
  }

  if (!payload) {
    return res.status(404).json({ error: `Handle "${handle}" not found in cache — reload the preview first.` });
  }

  const variants = payload.variants.map(v => ({
    model: v.optionValues.find(o => o.optionName === 'Phone Model')?.name ?? '—',
    style: v.optionValues.find(o => o.optionName === 'Style')?.name ?? '—',
    sku:   v.sku,
    price: parseFloat(v.price),
  }));

  res.json({ handle, count: variants.length, variants });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE: POST /api/product/:handle/override
//
// Patches the in-memory preview cache for a given handle so that the NEXT
// /api/import/stream call uses the user-edited values instead of the raw
// CSV-derived payload.
//
// Body (all fields optional):
//   { title?: string, productType?: string, basePrice?: number,
//     bodyHtml?: string, tags?: string[] | string }
//
// basePrice is treated as the desired new MINIMUM variant price.  All variant
// prices are rescaled proportionally to preserve the bundle price structure.
//
// tags, when provided, are MERGED (not replaced) into the existing payload.tags
// array via Set deduplication.  This allows the After Pane's Tags input to add
// manual tags on top of the auto-assigned taxonomy set without wiping it.
//
// Returns: { ok: true, handle, appliedTitle, appliedProductType, tagCount }
// ═══════════════════════════════════════════════════════════════════════════════
// ── Style / Model lookup tables (mirrors transform.mjs — single source for server-side ops) ──

// Canonical prices per bundle style (no strap — strap is normalised to grip at CSV parse time)
const _STYLE_PRICES = {
  'Case+Grip+Charm': 409.89,
  'Case+Grip':       350.11,
  'Case+Charm':      350.11,
  'Case Only':       261.86,
  'Grip Only':       170.76,
  'Charm Only':      113.82,
};

// SKU suffix codes per bundle style
const _STYLE_SKU_CODE = {
  'Case+Grip+Charm': 'CGC',
  'Case+Grip':       'CG',
  'Case+Charm':      'CC',
  'Case Only':       'CO',
  'Grip Only':       'GO',
  'Charm Only':      'CHO',
};

// SKU model codes — mirrors MODEL_SKU_CODE in transform.mjs
const _MODEL_SKU_CODE = {
  'iPhone 17 Pro Max': '17PM',
  'iPhone 17 Pro':     '17PR',
  'iPhone 17':         '17',
  'iPhone 16 Pro Max': '16PM',
  'iPhone 16 Pro':     '16PR',
  'iPhone 16':         '16',
  'iPhone 15 Pro Max': '15PM',
  'iPhone 15 Pro':     '15PR',
  'iPhone 15':         '15',
  'iPhone 14 Pro Max': '14PM',
  'iPhone 14 Pro':     '14PR',
  'iPhone 14/13':      '1413',
};

app.post('/api/product/:handle/override', (req, res) => {
  const { handle } = req.params;
  const { title, productType, basePrice, bodyHtml, tags, productCategory, removedSkus, styleRemaps, addStyles } = req.body ?? {};

  const payload = _cache?.payloadMap?.get(handle) ?? null;
  if (!payload) {
    return res.status(404).json({
      error: `Handle "${handle}" not found in cache — reload the preview first.`,
    });
  }

  // Title override — also update SEO title; do NOT change handle (it's the map key)
  if (typeof title === 'string' && title.trim()) {
    const t = title.trim();
    payload.title     = t;
    payload.seo.title = t;
  }

  // Product type / collection override
  if (typeof productType === 'string' && productType.trim()) {
    payload.productType = productType.trim();
  }

  // Base-price override — scale all variant prices proportionally from the
  // current minimum so the bundle pricing structure is preserved.
  const price = parseFloat(basePrice);
  if (!isNaN(price) && price > 0) {
    const currentPrices = payload.variants.map(v => parseFloat(v.price));
    const currentMin    = Math.min(...currentPrices);
    if (currentMin > 0 && Math.abs(price - currentMin) > 0.005) {
      const scale = price / currentMin;
      for (const v of payload.variants) {
        v.price = (parseFloat(v.price) * scale).toFixed(2);
      }
    }
  }

  // Description override — sync to both fields so the productSet mutation sends
  // the user-edited copy (loader.mjs reads payload.descriptionHtml).
  if (typeof bodyHtml === 'string') {
    payload.bodyHtml        = bodyHtml;
    payload.descriptionHtml = bodyHtml;
  }

  // Tags override — MERGE incoming tags into existing array (never replace).
  // Accepts a string[] from the client; a comma-separated string is also
  // tolerated for convenience.
  if (tags !== undefined && tags !== null) {
    const incoming = Array.isArray(tags)
      ? tags
      : String(tags).split(',').map(t => t.trim()).filter(Boolean);
    if (incoming.length) {
      payload.tags = [...new Set([...(payload.tags ?? []), ...incoming])];
    }
  }

  // Taxonomy category override — store as the object structure productSet requires.
  // Client sends a plain GID string; we wrap it here before it reaches the mutation.
  if (typeof productCategory === 'string' && productCategory.trim()) {
    payload.productCategory = { productTaxonomyNodeId: productCategory.trim() };
  }

  // Variant deletion — remove variants whose SKU is in removedSkus[]
  if (Array.isArray(removedSkus) && removedSkus.length) {
    const removed = new Set(removedSkus);
    payload.variants = payload.variants.filter(v => !removed.has(v.sku));
    // Re-sync style option values to only those still present in variants
    const usedStyles = new Set(payload.variants.map(v =>
      v.optionValues?.find(o => o.optionName === 'Style')?.name
    ).filter(Boolean));
    if (payload.productOptions) {
      const styleOpt = payload.productOptions.find(o => o.name === 'Style');
      if (styleOpt) styleOpt.values = styleOpt.values.filter(val => usedStyles.has(val.name));
    }
  }

  // Style remap — bulk-rename a style name across all affected variants.
  //
  // For each { from, to } pair:
  //   1. Update the 'Style' optionValue on every matching variant.
  //   2. Recalculate the SKU suffix (last dash-segment) using _REMAP_SKU_CODE.
  //   3. Recalculate the variant price from _REMAP_PRICES (when a known style).
  //   4. Patch productOptions.Style.values (rename in-place or merge if target exists).
  // After all remaps, deduplicate variants by (Phone Model × Style) key so
  // merging two styles into one never leaves ghost duplicates in the payload.
  if (Array.isArray(styleRemaps) && styleRemaps.length) {
    for (const { from, to } of styleRemaps) {
      if (!from || !to || from === to) continue;

      // ── Special sentinel: remove all variants of `from` style ─────────────
      // The client sends `to === '__REMOVE__'` when the user selects
      // "✕ Remove this style" from the dropdown in the remap panel.
      // This is equivalent to deleting every variant row of that style.
      if (to === '__REMOVE__') {
        payload.variants = payload.variants.filter(v => {
          const styleVal = v.optionValues?.find(o => o.optionName === 'Style');
          return styleVal?.name !== from;
        });
        if (payload.productOptions) {
          const styleOpt = payload.productOptions.find(o => o.name === 'Style');
          if (styleOpt) styleOpt.values = styleOpt.values.filter(v => v.name !== from);
        }
        continue;
      }

      const newStyleCode = _STYLE_SKU_CODE[to]
        ?? to.replace(/[^a-zA-Z0-9+]/g, '').slice(0, 4).toUpperCase();
      const newPrice = _STYLE_PRICES[to] ?? null;

      // ── 1 & 2 & 3: Update every variant whose Style matches `from` ──────────
      for (const variant of payload.variants) {
        const styleVal = variant.optionValues?.find(o => o.optionName === 'Style');
        if (!styleVal || styleVal.name !== from) continue;

        styleVal.name = to;

        // Recalculate SKU suffix — format is always Y2K-CHAR-MODEL-STYLE
        const skuParts = variant.sku.split('-');
        skuParts[skuParts.length - 1] = newStyleCode;
        variant.sku = skuParts.join('-');

        // Recalculate price when the target style has a canonical price
        if (newPrice !== null) {
          variant.price = newPrice.toFixed(2);
        }
      }

      // ── 4: Patch productOptions.Style values list ─────────────────────────
      if (payload.productOptions) {
        const styleOpt = payload.productOptions.find(o => o.name === 'Style');
        if (styleOpt) {
          const fromIdx  = styleOpt.values.findIndex(v => v.name === from);
          const toExists = styleOpt.values.some(v => v.name === to);
          if (fromIdx !== -1) {
            if (toExists) {
              // Target already present — drop the old entry (variants merged)
              styleOpt.values.splice(fromIdx, 1);
            } else {
              // Rename in place so ordering is preserved
              styleOpt.values[fromIdx] = { name: to };
            }
          }
        }
      }
    }

    // ── Deduplication: (Phone Model × Style) must be unique after remaps ─────
    // If two styles were remapped to the same target, variants sharing both the
    // same model AND the same new style would create a duplicate option combo
    // that Shopify rejects.  Keep the first occurrence; discard subsequent ones.
    const seenCombos = new Set();
    payload.variants = payload.variants.filter(variant => {
      const model = variant.optionValues?.find(o => o.optionName === 'Phone Model')?.name ?? '';
      const style = variant.optionValues?.find(o => o.optionName === 'Style')?.name ?? '';
      const key   = `${model}||${style}`;
      if (seenCombos.has(key)) return false;
      seenCombos.add(key);
      return true;
    });
  }

  // Add new style — generate fresh variants for every current Phone Model × new style.
  //
  // Extracts the char code from the first existing SKU (format Y2K-CHAR-MODEL-STYLE)
  // so new SKUs are consistent with the product's existing ones.
  // Skips styles already present on the product (idempotent).
  if (Array.isArray(addStyles) && addStyles.length) {
    // Extract char code from the first variant's SKU
    const firstSku  = payload.variants[0]?.sku ?? '';
    const charCode  = firstSku.split('-')[1] ?? 'MISC';

    // Collect unique models in their existing order
    const seenModels    = [];
    const seenModelSet  = new Set();
    for (const v of payload.variants) {
      const model = v.optionValues?.find(o => o.optionName === 'Phone Model')?.name;
      if (model && !seenModelSet.has(model)) {
        seenModels.push(model);
        seenModelSet.add(model);
      }
    }

    for (const styleName of addStyles) {
      if (!styleName || typeof styleName !== 'string') continue;

      // Idempotent — skip if style already exists on this product
      const alreadyExists = payload.variants.some(v =>
        v.optionValues?.find(o => o.optionName === 'Style')?.name === styleName
      );
      if (alreadyExists) continue;

      const newStyleCode = _STYLE_SKU_CODE[styleName]
        ?? styleName.replace(/[^a-zA-Z0-9+]/g, '').slice(0, 4).toUpperCase();
      const newPrice = (_STYLE_PRICES[styleName]
        ?? parseFloat(payload.variants[0]?.price ?? 0)).toFixed(2);

      // Generate one variant per model × new style
      for (const model of seenModels) {
        const modelCode = _MODEL_SKU_CODE[model]
          ?? model.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase();

        payload.variants.push({
          optionValues: [
            { optionName: 'Phone Model', name: model },
            { optionName: 'Style',       name: styleName },
          ],
          price:           newPrice,
          sku:             `Y2K-${charCode}-${modelCode}-${newStyleCode}`,
          inventoryPolicy: 'DENY',
          inventoryItem:   { tracked: true },
          taxable:         true,
        });
      }

      // Register the new style in productOptions so Shopify sees it
      if (payload.productOptions) {
        const styleOpt = payload.productOptions.find(o => o.name === 'Style');
        if (styleOpt && !styleOpt.values.some(v => v.name === styleName)) {
          styleOpt.values.push({ name: styleName });
        }
      }
    }
  }

  payload._overriddenAt = new Date().toISOString();

  res.json({
    ok:                 true,
    handle,
    appliedTitle:       payload.title,
    appliedProductType: payload.productType,
    tagCount:           payload.tags.length,
    variantCount:       payload.variants.length,
  });
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ═══════════════════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════════════════
const server = createServer(app);

server.listen(PORT, async () => {
  const url = `http://localhost:${PORT}`;
  console.log('');
  console.log('  ══ Y2KASE Import Dashboard ══════════════════════');
  console.log(`  Running at ${url}`);
  console.log(`  Store:   ${STORE ?? '(not set)'}`);
  console.log(`  CSV:     ${CSV_PATH}`);
  console.log(`  History: ${HISTORY_PATH}`);

  // ── Taxonomy cache health check ────────────────────────────────────────
  if (isTaxonomyCachePopulated()) {
    const fetchedAt = taxonomyCacheFetchedAt();
    console.log(`  Taxonomy cache: OK (fetched ${fetchedAt ?? 'unknown'})`);
  } else {
    console.log('');
    console.log('  ⚠  Taxonomy cache missing — category metafields will use');
    console.log('     hardcoded GIDs only (case-type, material, transparency).');
    console.log('     Run the following to unlock all 25 attributes:');
    console.log('     node scripts/lib/fetch-taxonomy-attrs.mjs');
    console.log('');
  }

  console.log('  Press Ctrl+C to stop.');
  console.log('');
  await open(url);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`  Port ${PORT} is already in use. Stop the existing process first.`);
  } else {
    console.error(`  Server error: ${err.message}`);
  }
  process.exit(1);
});
