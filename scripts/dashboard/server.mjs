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
import { loadProduct }         from '../lib/loader.mjs';
import { shopifyGql, resolveLocationId } from '../shopify-client.mjs';

// ── Paths ─────────────────────────────────────────────────────────────────────
const __dirname    = dirname(fileURLToPath(import.meta.url));
const ROOT         = resolve(__dirname, '../..');
const PUBLIC_DIR   = join(__dirname, 'public');
const ENV_PATH     = resolve(ROOT, '.env');
const CSV_PATH     = resolve(ROOT, 'EtsyListingsDownload.csv');
const HISTORY_PATH = resolve(ROOT, 'import-history.json');

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
const VERSION = process.env.SHOPIFY_API_VERSION || '2025-04';

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
  const etsySide = {
    title:        payload.title,
    variantCount: payload.variants.length,
    priceRange:   `${Math.min(...etsyPrices).toFixed(2)}–${Math.max(...etsyPrices).toFixed(2)}`,
    imageCount:   payload._images.length,
    productType:  payload.productType,
    status:       'DRAFT',
  };

  if (!shopifyProduct) {
    return { status: 'new', etsy: etsySide, shopify: null, diffs: [] };
  }

  const spPrices = shopifyProduct.variants.edges.map(e => parseFloat(e.node.price));
  const shopifySide = {
    title:        shopifyProduct.title,
    variantCount: shopifyProduct.variants.edges.length,
    priceRange:   spPrices.length
      ? `${Math.min(...spPrices).toFixed(2)}–${Math.max(...spPrices).toFixed(2)}`
      : '—',
    imageCount:   shopifyProduct.media.edges.length,
    productType:  shopifyProduct.productType ?? '',
    status:       shopifyProduct.status,
  };

  const diffs = [];
  const cmp = (field, a, b) => { if (String(a) !== String(b)) diffs.push({ field, etsy: a, shopify: b }); };

  cmp('title',        etsySide.title,        shopifySide.title);
  cmp('variantCount', etsySide.variantCount,  shopifySide.variantCount);
  cmp('priceRange',   etsySide.priceRange,    shopifySide.priceRange);
  cmp('imageCount',   etsySide.imageCount,    shopifySide.imageCount);
  cmp('productType',  etsySide.productType,   shopifySide.productType);

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
    // ── 1. Parse CSV + transform ──────────────────────────────────────────────
    const payloadMap = new Map();     // handle → full payload (needed by stream route)
    const seen       = new Set();     // dedup: one entry per handle
    const ordered    = [];            // [{ handle, payload, etsySku }] in CSV order

    for await (const raw of parseCsvFile(CSV_PATH)) {
      const etsy = normalizeEtsyRecord(raw);
      // Title is the only hard requirement — missing models/styles are handled
      // by resolveVariations() (smart fallbacks) inside buildShopifyPayload().
      if (!etsy.title) continue;

      let payload;
      try {
        payload = buildShopifyPayload(etsy);
      } catch (err) {
        console.warn(`[preview] transform failed: "${etsy.title.slice(0, 50)}" — ${err.message}`);
        continue;
      }

      // Skip products that ended up with zero variants even after fallbacks
      if (!payload.variants.length) continue;

      if (seen.has(payload.handle)) continue; // deduplicate by generated handle
      seen.add(payload.handle);
      payloadMap.set(payload.handle, payload);
      // Preserve raw etsy fields alongside payload for preview enrichment
      ordered.push({ handle: payload.handle, payload, etsySku: etsy.etsySku, etsy });
    }

    // ── 2. Batch-check Shopify for existing products ──────────────────────────
    const handles    = ordered.map(o => o.handle);
    const shopifyMap = await fetchShopifyProducts(handles);

    // ── 3. Compute diff for each product ─────────────────────────────────────
    const results = ordered.map(({ handle, payload, etsySku, etsy }) => {
      const shopifyProduct = shopifyMap.get(handle) ?? null;
      const diff           = computeDiff(payload, shopifyProduct);
      const etsyPrices     = payload.variants.map(v => parseFloat(v.price));

      return {
        status:       diff.status,          // 'new' | 'conflict' | 'match'
        handle,
        title:        payload.title,
        etsySku:      etsySku || null,
        variantCount:     payload.variants.length,  // dynamic: models.length × styles.length
        modelCount:       etsy.models.length,        // raw VARIATION 1 VALUES count
        styleCount:       etsy.styles.length,        // raw VARIATION 2 VALUES count
        fallbacksApplied: payload._meta.fallbacksApplied ?? null,
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

      try {
        const result = await loadProduct(payload, locationId, {
          dryRun:       false,
          skipExisting: true,
          onProgress:   (event) => {
            // Relay each step event back to the SSE stream
            emit({ ...event, index: idx, total: handles.length, handle });
          },
        });

        emit({ type: 'product_done', index: idx, total: handles.length, handle,
               status: result.status, variantCount: result.variantCount ?? null,
               mediaCount: result.mediaCount ?? null, productId: result.productId ?? null });

        summary[result.status === 'created' ? 'created' : 'skipped']++;

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
      if (!etsy.title || !etsy.models.length || !etsy.styles.length) continue;
      try {
        const p = buildShopifyPayload(etsy);
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
// ROUTE: POST /api/product/:handle/override
//
// Patches the in-memory preview cache for a given handle so that the NEXT
// /api/import/stream call uses the user-edited values instead of the raw
// CSV-derived payload.
//
// Body (all fields optional):
//   { title?: string, productType?: string, basePrice?: number }
//
// basePrice is treated as the desired new MINIMUM variant price.  All variant
// prices are rescaled proportionally to preserve the bundle price structure.
//
// Returns: { ok: true, handle, appliedTitle, appliedProductType }
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/product/:handle/override', (req, res) => {
  const { handle } = req.params;
  const { title, productType, basePrice } = req.body ?? {};

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

  payload._overriddenAt = new Date().toISOString();

  res.json({
    ok:                 true,
    handle,
    appliedTitle:       payload.title,
    appliedProductType: payload.productType,
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
