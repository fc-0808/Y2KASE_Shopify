/**
 * Y2KASE Import Dashboard — dashboard.js  (Phase 4)
 *
 * Pure Vanilla JS — zero external libraries.
 *
 * Sections:
 *   1. Constants & application state
 *   2. DOM references
 *   3. Utilities  (esc, fetchJson, ts, fmtTs, fmtDur)
 *   4. Status bar  (loadPreflight, tokenRefresh)
 *   5. Audit table (loadPreview, renderAuditRows, renderRow, filter, checkbox sync)
 *   6. Conflict Inspector modal
 *   7. Import engine (startImport, handleSseEvent, addLogLine, updateProgressBar)
 *   8. History
 *   9. Boot (DOMContentLoaded)
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// 1. CONSTANTS & STATE
// ─────────────────────────────────────────────────────────────────────────────

const FILTER_ORDER  = ['all', 'new', 'conflict', 'match'];
const FILTER_LABELS = { all: 'Filter ▾', new: 'New ✕', conflict: 'Conflict ✕', match: 'Match ✕' };

// Fields shown in both diff panes, in display order.
const DIFF_FIELDS = [
  { key: 'title',        label: 'Title',        fmt: v => v },
  { key: 'variantCount', label: 'Variants',      fmt: v => `${v} variant${v !== 1 ? 's' : ''}` },
  { key: 'priceRange',   label: 'Price Range',   fmt: v => `HK$ ${v}` },
  { key: 'imageCount',   label: 'Images',        fmt: v => `${v} image${v !== 1 ? 's' : ''}` },
  { key: 'productType',  label: 'Product Type',  fmt: v => v },
  { key: 'status',       label: 'Status',        fmt: v => v },
];

const app = {
  products:      [],           // full /api/preview payload
  productMap:    new Map(),    // handle → product  (O(1) modal look-up)
  activeHandle:  null,         // handle shown in modal
  importSource:  null,         // active EventSource instance
  importRunning: false,
  filterState:   'all',        // current filter cycle value
  importStats:   { created: 0, skipped: 0, errors: 0, total: 0 },
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. DOM REFERENCES
// ─────────────────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

// Declared lazily — populated after DOMContentLoaded to avoid null refs.
let D = {};

function cacheDOM() {
  D = {
    // Status bar
    statusChecks:     $('status-checks'),
    btnRefreshToken:  $('btn-refresh-token'),
    btnPreview:       $('btn-preview'),
    previewSpinner:   $('preview-spinner'),
    btnPreviewLabel:  $('btn-preview-label'),

    // Audit table
    totalCount:       $('total-count'),
    countNew:         $('count-new'),
    countConflict:    $('count-conflict'),
    countMatch:       $('count-match'),
    auditTbody:       $('audit-tbody'),
    chkMaster:        $('chk-master'),
    btnImport:        $('btn-import-selected'),
    btnCancelImport:  $('btn-cancel-import'),
    selectedCount:    $('selected-count'),
    btnSelectAll:     $('btn-select-all'),
    btnFilter:        $('btn-filter'),

    // Progress panel
    statCreated:      $('stat-created'),
    statSkipped:      $('stat-skipped'),
    statErrors:       $('stat-errors'),
    statTotal:        $('stat-total'),
    progressFill:     $('progress-fill'),
    progressFraction: $('progress-fraction'),
    progressLog:      $('progress-log'),
    btnClearLog:      $('btn-clear-log'),

    // History
    historyCount:     $('history-count'),
    historyTbody:     $('history-tbody'),

    // Modal — static chrome
    modal:            $('conflict-modal'),
    modalBackdrop:    $('modal-backdrop'),
    modalHandle:      $('modal-handle'),
    modalClose:       $('modal-close'),
    modalConflictNote:$('modal-conflict-count'),
    btnModalSkip:     $('btn-modal-skip'),
    btnModalAck:      $('btn-modal-overwrite'),

    // Modal — Before pane (Etsy Original)
    beforeRawTitle:   $('before-raw-title'),
    beforeModels:     $('before-models'),
    beforeStyles:     $('before-styles'),
    beforeTags:       $('before-tags'),
    beforeModelCount: $('before-model-count'),
    beforeStyleCount: $('before-style-count'),

    // Modal — After pane static containers (still referenced for future use)
    afterHero:        $('after-hero'),
    afterMeta:        $('after-meta'),

    // Modal — After pane editable override inputs
    overrideTitle:       $('override-title'),
    overrideProductType: $('override-product-type'),
    overrideBasePrice:   $('override-base-price'),

    // Modal — After pane read-only display elements
    afterImgSlot:     $('after-img-slot'),
    afterVariantBadge:$('after-variant-badge'),
    afterSkuSample:   $('after-sku-sample'),

    // Modal — Fallback badge in pane header
    fallbackBadge:    $('fallback-badge'),

    // Modal — Save Overrides button
    btnSaveOverrides: $('btn-save-overrides'),

    // Modal — Field diff (collapsible)
    diffDetails:      $('diff-details'),
    diffBadge:        $('diff-badge'),
    diffEtsy:         $('diff-etsy'),
    diffShopify:      $('diff-shopify'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

/** Escape a value for safe insertion into innerHTML. */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Current wall-clock timestamp as HH:MM:SS. */
function ts() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, '0'))
    .join(':');
}

/** ISO 8601 → "YYYY-MM-DD · HH:MM" local time. */
function fmtTs(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return `${date} · ${time}`;
  } catch { return iso; }
}

/** Milliseconds → "X.Xs" or "Xm Ys". */
function fmtDur(ms) {
  if (!ms && ms !== 0) return '—';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * Fetch JSON with unified error handling.
 * Throws a descriptive Error on non-2xx responses.
 */
async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body = await res.text().catch(() => '(no body)');
    throw new Error(`HTTP ${res.status} from ${url}: ${body.slice(0, 160)}`);
  }
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. STATUS BAR
// ─────────────────────────────────────────────────────────────────────────────

async function loadPreflight() {
  try {
    const data = await fetchJson('/api/preflight');
    renderPreflight(data);
  } catch (err) {
    D.statusChecks.innerHTML = pill('err', 'Preflight', `Error: ${esc(err.message)}`);
  }
}

function pill(state, label, value) {
  return `
    <div class="check-pill ${esc(state)}">
      <span class="dot"></span>
      <span class="pill-label">${esc(label)}</span>
      <span class="pill-value">${esc(value)}</span>
    </div>`;
}

function renderPreflight({ token, csv, location }) {
  const tokenState = token.ok ? 'ok' : 'err';
  const tokenVal   = token.ok
    ? `${token.shop} · Authenticated`
    : `Error: ${token.reason}`;

  const csvState = csv.ok ? 'ok' : 'err';
  const csvVal   = csv.ok ? `${csv.rows.toLocaleString()} rows` : 'File not found';

  const locState = location.ok ? 'ok' : (token.ok ? 'err' : 'warn');
  const locShort = (location.name ?? '').split(' ').slice(0, 3).join(' ');
  const locId    = location.id ? location.id.split('/').pop() : null;
  const locVal   = location.ok
    ? `${locShort}${locId ? ` (${locId})` : ''}`
    : (location.reason ?? 'Not resolved');

  D.statusChecks.innerHTML =
    pill(tokenState, 'Token',    tokenVal) +
    pill(csvState,   'CSV',      csvVal)   +
    pill(locState,   'Location', locVal);
}

async function tokenRefresh() {
  D.btnRefreshToken.disabled = true;
  D.btnRefreshToken.textContent = 'Refreshing…';
  try {
    const data = await fetchJson('/api/token/refresh', { method: 'POST' });
    if (data.ok) {
      D.btnRefreshToken.textContent = 'Refreshed ✓';
      setTimeout(() => { D.btnRefreshToken.textContent = 'Refresh Token'; D.btnRefreshToken.disabled = false; }, 3000);
      await loadPreflight();
    } else {
      D.btnRefreshToken.textContent = 'Failed';
      setTimeout(() => { D.btnRefreshToken.textContent = 'Refresh Token'; D.btnRefreshToken.disabled = false; }, 4000);
      addLogLine('error', '✗', `Token refresh failed: ${data.reason}`);
    }
  } catch (err) {
    D.btnRefreshToken.textContent = 'Error';
    setTimeout(() => { D.btnRefreshToken.textContent = 'Refresh Token'; D.btnRefreshToken.disabled = false; }, 4000);
    addLogLine('error', '✗', `Token refresh error: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. AUDIT TABLE
// ─────────────────────────────────────────────────────────────────────────────

async function loadPreview() {
  D.previewSpinner.removeAttribute('hidden');
  D.btnPreviewLabel.textContent = 'Loading…';
  D.btnPreview.disabled = true;

  try {
    const products = await fetchJson('/api/preview');
    app.products  = products;
    app.productMap = new Map(products.map(p => [p.handle, p]));

    renderAuditRows(products);
    updateSummaryCounts(products);
  } catch (err) {
    D.auditTbody.innerHTML = emptyState('✗', 'Preview failed', esc(err.message));
    addLogLine('error', '✗', `Preview error: ${err.message}`);
  } finally {
    D.previewSpinner.setAttribute('hidden', '');
    D.btnPreviewLabel.textContent = 'Reload Preview';
    D.btnPreview.disabled = false;
  }
}

function emptyState(icon, title, body) {
  return `<tr><td colspan="8">
    <div class="empty-state">
      <div class="empty-icon">${icon}</div>
      <div class="empty-title">${title}</div>
      <div class="empty-body">${body}</div>
    </div>
  </td></tr>`;
}

function renderAuditRows(products) {
  if (!products.length) {
    D.auditTbody.innerHTML = emptyState('✦', 'No products found', 'Check that EtsyListingsDownload.csv exists and has valid rows.');
    D.totalCount.textContent = '0';
    syncMasterCheckbox();
    syncImportButton();
    return;
  }

  D.auditTbody.innerHTML = products.map(renderRow).join('');
  D.totalCount.textContent = String(products.length);

  // Wire row-level interactions once after a single DOM update
  D.auditTbody.querySelectorAll('.row-check').forEach(cb => {
    cb.addEventListener('change', () => { syncMasterCheckbox(); syncImportButton(); });
  });

  D.auditTbody.querySelectorAll('.btn-inspect').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); openModal(btn.dataset.handle); });
  });

  D.auditTbody.querySelectorAll('.conflict-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('input, button')) return;
      openModal(row.dataset.handle);
    });
  });

  syncMasterCheckbox();
  syncImportButton();
}

function renderRow(p) {
  const isNew      = p.status === 'new';
  const isConflict = p.status === 'conflict';
  const isMatch    = p.status === 'match';

  // NEW → pre-checked; CONFLICT → unchecked (require explicit acknowledgement); MATCH → disabled
  const checked  = isNew ? 'checked' : '';
  const disabled = isMatch ? 'disabled' : '';
  const rowClass = [isConflict ? 'conflict-row' : '', isMatch ? 'match-row' : ''].filter(Boolean).join(' ');

  const badgeClass = isNew ? 'badge-new' : isConflict ? 'badge-conflict' : 'badge-match';
  const badgeLabel = isNew ? 'New'       : isConflict ? 'Conflict'       : 'Match';

  // Price: single value or min–max range
  const pMin = Math.round(p.priceMin ?? 0);
  const pMax = Math.round(p.priceMax ?? 0);
  const priceDisplay = pMin === pMax ? `HK$${pMin}` : `HK$${pMin}–${pMax}`;

  // Thumbnail — graceful no-image fallback
  const imgCell = p.imageUrl
    ? `<img src="${esc(p.imageUrl)}" alt="${esc(p.title)}" class="thumb" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'thumb-placeholder'}))">`
    : '<span class="thumb-placeholder"></span>';

  // Variant badge: count + dynamic breakdown when both dimensions are known
  const variantCell = p.modelCount && p.styleCount
    ? `<span class="variant-badge">${p.variantCount}</span>
       <small class="variant-math">${p.modelCount}×${p.styleCount}</small>`
    : `<span class="variant-badge">${p.variantCount}</span>`;

  const actionCell = isConflict
    ? `<button class="btn btn-ghost btn-sm btn-inspect" data-handle="${esc(p.handle)}" aria-label="Inspect conflict">Inspect</button>`
    : '';

  // Phase 1 fallback indicator — shown when smart defaults were applied
  const fallbackHtml = Array.isArray(p.fallbacksApplied) && p.fallbacksApplied.length
    ? `<span class="fallback-badge-inline" title="Auto-filled by smart fallback: ${esc(p.fallbacksApplied.join(', '))}">⚠ Fallback</span>`
    : '';

  return `
    <tr data-status="${p.status}" data-handle="${esc(p.handle)}" class="${rowClass}">
      <td class="col-img">${imgCell}</td>
      <td class="col-check">
        <input type="checkbox" class="row-check" data-handle="${esc(p.handle)}" ${checked} ${disabled}>
      </td>
      <td><span class="badge ${badgeClass}">${badgeLabel}</span></td>
      <td title="${esc(p.etsyTitle ?? p.title)}">${esc(p.title)}${fallbackHtml}</td>
      <td class="col-handle"><span class="handle">${esc(p.handle)}</span></td>
      <td class="col-variants">${variantCell}</td>
      <td class="col-price">${esc(priceDisplay)}</td>
      <td>${actionCell}</td>
    </tr>`;
}

function updateSummaryCounts(products) {
  const count = status => products.filter(p => p.status === status).length;
  D.countNew.textContent      = count('new');
  D.countConflict.textContent = count('conflict');
  D.countMatch.textContent    = count('match');
}

// ── Checkbox sync helpers ─────────────────────────────────────────────────────

function syncMasterCheckbox() {
  const all       = [...document.querySelectorAll('.row-check:not(:disabled)')];
  const nChecked  = all.filter(c => c.checked).length;
  D.chkMaster.checked      = all.length > 0 && nChecked === all.length;
  D.chkMaster.indeterminate = nChecked > 0 && nChecked < all.length;
}

function syncImportButton() {
  const n = document.querySelectorAll('.row-check:not(:disabled):checked').length;
  // selectedCount span may be re-created during endImport, so always look it up fresh
  const span = $('selected-count');
  if (span) span.textContent = `(${n})`;
  D.btnImport.disabled = n === 0 || app.importRunning;
}

// ── Filter cycle ──────────────────────────────────────────────────────────────

function cycleFilter() {
  const idx = FILTER_ORDER.indexOf(app.filterState);
  app.filterState = FILTER_ORDER[(idx + 1) % FILTER_ORDER.length];

  const table = document.getElementById('audit-table');
  table.classList.remove('filter-new', 'filter-conflict', 'filter-match');
  if (app.filterState !== 'all') table.classList.add(`filter-${app.filterState}`);

  D.btnFilter.textContent = FILTER_LABELS[app.filterState];
  D.btnFilter.classList.toggle('active', app.filterState !== 'all');
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. CONFLICT INSPECTOR MODAL
// ─────────────────────────────────────────────────────────────────────────────

function openModal(handle) {
  const product = app.productMap.get(handle);
  if (!product) return;

  app.activeHandle = handle;
  D.modalHandle.textContent = handle;

  // Footer conflict note
  const n = product.diffs?.length ?? 0;
  D.modalConflictNote.textContent = product.shopify
    ? `${n} field conflict${n !== 1 ? 's' : ''} detected · Overwriting replaces the live Shopify product.`
    : 'This product does not yet exist in Shopify yet.';

  // ── Section 1: Visual Before/After split ──────────────────────────────────
  renderBeforePane(product);
  renderAfterPane(product);

  // ── Section 2: Collapsible field diff ─────────────────────────────────────
  renderDiffPane(D.diffEtsy,    product.etsy,    product.diffs);
  renderDiffPane(D.diffShopify, product.shopify, product.diffs);

  // Diff badge: count + colour
  D.diffBadge.textContent = n === 0 ? '0 changes' : `${n} change${n !== 1 ? 's' : ''}`;
  D.diffBadge.classList.toggle('no-diffs', n === 0);

  // Auto-open the diff section when there are conflicts; collapse when clean
  if (D.diffDetails) D.diffDetails.open = n > 0;

  D.modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  D.modalClose.focus();
}

function closeModal() {
  D.modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  app.activeHandle = null;
}

/** Populate the LEFT "Etsy Original" pane. */
function renderBeforePane(product) {
  // Keyword-stuffed raw title
  D.beforeRawTitle.textContent = product.etsyTitle ?? product.title;

  // Model and style chip counts
  const mc = product.etsyModels?.length ?? 0;
  const sc = product.etsyStyles?.length ?? 0;
  if (D.beforeModelCount) D.beforeModelCount.textContent = mc ? `(${mc})` : '';
  if (D.beforeStyleCount) D.beforeStyleCount.textContent = sc ? `(${sc})` : '';

  // Chip lists
  const chips = (arr, maxChips = 20) =>
    (arr ?? []).slice(0, maxChips)
      .map(v => `<span class="chip" title="${esc(v)}">${esc(v)}</span>`)
      .join('');

  D.beforeModels.innerHTML = chips(product.etsyModels);
  D.beforeStyles.innerHTML = chips(product.etsyStyles);
  D.beforeTags.innerHTML   = chips(product.etsyTags, 30);
}

/** Populate the RIGHT "Shopify Preview" pane.
 *
 * Now operates entirely via direct property mutation on pre-rendered static
 * elements — no innerHTML injection.  This lets the editable <input> elements
 * retain their values and event listeners across repeated openModal() calls.
 */
function renderAfterPane(product) {
  // ── Image slot ────────────────────────────────────────────────────────────
  if (product.imageUrl) {
    const img    = document.createElement('img');
    img.src      = product.imageUrl;
    img.className = 'inspector-img';
    img.alt      = product.title;
    img.loading  = 'lazy';
    img.addEventListener('error', () => {
      const ph = document.createElement('div');
      ph.className   = 'inspector-img-placeholder';
      ph.textContent = '🖼';
      img.replaceWith(ph);
    });
    D.afterImgSlot.replaceChildren(img);
  } else {
    const ph = document.createElement('div');
    ph.className   = 'inspector-img-placeholder';
    ph.textContent = '🖼';
    D.afterImgSlot.replaceChildren(ph);
  }

  // ── Editable override fields — seed from current in-memory values ─────────
  D.overrideTitle.value       = product.title;
  D.overrideProductType.value = product.collection ?? '';
  D.overrideBasePrice.value   = (product.priceMin ?? 0).toFixed(2);

  // ── Read-only display fields ───────────────────────────────────────────────
  if (product.modelCount && product.styleCount) {
    D.afterVariantBadge.innerHTML =
      `${product.variantCount} <small>${product.modelCount}×${product.styleCount}</small>`;
  } else {
    D.afterVariantBadge.textContent = String(product.variantCount ?? '—');
  }
  D.afterSkuSample.textContent = product.sampleSku ?? '—';

  // ── Fallback badge (Phase 1 smart-fallback indicator) ─────────────────────
  const hasFallbacks = Array.isArray(product.fallbacksApplied) && product.fallbacksApplied.length > 0;
  D.fallbackBadge.hidden = !hasFallbacks;
  if (hasFallbacks) {
    D.fallbackBadge.textContent = '⚠ Fallback Active';
    D.fallbackBadge.title = `Auto-filled by smart fallback: ${product.fallbacksApplied.join(', ')}`;
  }
}

/**
 * Render one side of the collapsible field diff.
 *
 * Field CSS state:
 *   same    — field is identical on both sides
 *   changed — field appears in the diffs array
 *   missing — summary is null (side has no live Shopify data)
 */
function renderDiffPane(paneEl, summary, diffs = []) {
  if (!paneEl) return;
  const changedFields = new Set((diffs ?? []).map(d => d.field));

  paneEl.innerHTML = DIFF_FIELDS.map(({ key, label, fmt }) => {
    const raw     = summary?.[key];
    const display = raw != null ? fmt(raw) : '—';
    const cls     = !summary ? 'missing' : changedFields.has(key) ? 'changed' : 'same';

    return `
      <div class="diff-field ${cls}">
        <div class="diff-field-key">${esc(label)}</div>
        <div class="diff-field-value">${esc(display)}</div>
      </div>`;
  }).join('');
}

// ── Override helpers ──────────────────────────────────────────────────────────

/**
 * Core data-binding function: reads the three editable inputs, diffs them
 * against the current productMap entry, writes any changes back to
 * app.productMap + app.products[], updates the audit table row, and fires a
 * fire-and-forget POST to /api/product/:handle/override so the server-side
 * cache reflects the edits before the import stream runs.
 *
 * @param {string} handle
 * @returns {object|null} The patch object that was applied, or null if nothing changed.
 */
function commitOverrides(handle) {
  const product = app.productMap.get(handle);
  if (!product) return null;

  const newTitle       = D.overrideTitle.value.trim();
  const newProductType = D.overrideProductType.value.trim();
  const newBasePrice   = parseFloat(D.overrideBasePrice.value);

  // Build a diff patch — only include fields that actually changed
  const patch = {};
  if (newTitle       && newTitle !== product.title)                              patch.title       = newTitle;
  if (newProductType && newProductType !== product.collection)                   patch.productType = newProductType;
  if (!isNaN(newBasePrice) && newBasePrice > 0 &&
      Math.abs(newBasePrice - (product.priceMin ?? 0)) > 0.005)                 patch.basePrice   = newBasePrice;

  if (!Object.keys(patch).length) return null; // nothing changed

  // ── 1. Update client-side productMap (synchronous) ─────────────────────
  const updated = { ...product };
  if (patch.title)       updated.title      = patch.title;
  if (patch.productType) updated.collection = patch.productType;
  if (patch.basePrice != null) {
    const oldMin = product.priceMin ?? 0;
    const oldMax = product.priceMax ?? 0;
    if (oldMin > 0) {
      const scale      = patch.basePrice / oldMin;
      updated.priceMin = patch.basePrice;
      updated.priceMax = parseFloat((oldMax * scale).toFixed(2));
    }
  }

  app.productMap.set(handle, updated);

  // Keep app.products array in sync so rerenders see the same values
  const idx = app.products.findIndex(p => p.handle === handle);
  if (idx !== -1) app.products[idx] = updated;

  // ── 2. Reflect changes in the audit table row immediately ───────────────
  updateRowFromOverride(handle, updated);

  // ── 3. Push patch to server (fire-and-forget) ───────────────────────────
  // The server patches _cache.payloadMap so the next SSE import run uses
  // the edited data, not the original CSV-derived payload.
  fetchJson(`/api/product/${encodeURIComponent(handle)}/override`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(patch),
  })
    .then(() => addLogLine('success', '✓', `Override applied: ${handle}`, handle))
    .catch(err => addLogLine('error', '✗', `Override POST failed: ${err.message}`, handle));

  return patch;
}

/**
 * Reflect edited title and price from an override into the visible audit
 * table row, preserving any inline fallback badge already in the title cell.
 */
function updateRowFromOverride(handle, product) {
  const row = D.auditTbody.querySelector(`tr[data-handle="${CSS.escape(handle)}"]`);
  if (!row) return;

  // cells[3] = Title column
  const titleCell = row.cells[3];
  if (titleCell) {
    const existingBadge = titleCell.querySelector('.fallback-badge-inline');
    titleCell.textContent = product.title;        // clears children
    if (existingBadge) titleCell.appendChild(existingBadge);
    titleCell.title = product.etsyTitle ?? product.title;
  }

  // cells[6] = Price column
  const priceCell = row.cells[6];
  if (priceCell) {
    const pMin = Math.round(product.priceMin ?? 0);
    const pMax = Math.round(product.priceMax ?? 0);
    priceCell.textContent = pMin === pMax ? `HK$${pMin}` : `HK$${pMin}–${pMax}`;
  }
}

/**
 * Temporarily replace a button's label to give visual feedback, then restore.
 */
function flashButton(btn, label, durationMs = 1800) {
  if (!btn) return;
  const original = btn.textContent;
  btn.textContent = label;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, durationMs);
}

/**
 * "Save Overrides": persist the edited fields and flash confirmation.
 * Called by the dedicated "Save Overrides" button.
 */
function saveOverrides() {
  const handle = app.activeHandle;
  if (!handle) return;
  const patch = commitOverrides(handle);
  flashButton(D.btnSaveOverrides, patch ? 'Saved ✓' : 'No changes');
}

/**
 * "Acknowledge & Select": silently commit any pending overrides, mark the
 * conflict row's checkbox as checked, then close the modal.
 */
function acknowledgeAndSelect() {
  const handle = app.activeHandle;
  if (handle) commitOverrides(handle); // silently apply edits before closing

  if (!handle) { closeModal(); return; }

  const cb = D.auditTbody.querySelector(`.row-check[data-handle="${CSS.escape(handle)}"]`);
  if (cb && !cb.disabled) {
    cb.checked = true;
    syncMasterCheckbox();
    syncImportButton();
  }

  closeModal();
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. IMPORT ENGINE  (SSE)
// ─────────────────────────────────────────────────────────────────────────────

function resetProgressPanel() {
  app.importStats = { created: 0, skipped: 0, errors: 0, total: 0 };
  D.statCreated.textContent      = '0';
  D.statSkipped.textContent      = '0';
  D.statErrors.textContent       = '0';
  D.statTotal.textContent        = '0';
  D.progressFill.style.width     = '0%';
  D.progressFraction.textContent = '0 / 0';
  D.progressLog.innerHTML        = '';
}

/** Append one line to the SSE log and scroll to bottom. */
function addLogLine(level, icon, msg, handle = null) {
  const line = document.createElement('div');
  line.className = `log-line ${level}`;

  // Render handle with accent colour; everything else is text-escaped
  const handleHtml = handle ? `<span class="log-handle">${esc(handle)}</span> — ` : '';

  line.innerHTML = `
    <span class="log-time">${ts()}</span>
    <span class="log-icon">${esc(icon)}</span>
    <span class="log-msg">${handleHtml}${esc(msg)}</span>`;

  D.progressLog.appendChild(line);
  D.progressLog.scrollTop = D.progressLog.scrollHeight;
}

/** Recompute progress bar and stat boxes from app.importStats. */
function updateProgressBar() {
  const { created, skipped, errors, total } = app.importStats;
  const done = created + skipped + errors;
  const pct  = total > 0 ? Math.round((done / total) * 100) : 0;

  D.progressFill.style.width     = `${pct}%`;
  D.progressFraction.textContent = `${done} / ${total}`;
  D.statCreated.textContent      = String(created);
  D.statSkipped.textContent      = String(skipped);
  D.statErrors.textContent       = String(errors);
  D.statTotal.textContent        = String(total);
}

/**
 * Dispatch a single SSE event object to the appropriate UI update.
 *
 * Event types emitted by /api/import/stream:
 *   start          — { total }
 *   log            — { level, msg }
 *   product_start  — { index, total, handle, title }
 *   step           — { index, total, handle, step, ...stepData }
 *   skipped        — { index, total, handle, reason }   (from loader.mjs onProgress)
 *   product_done   — { index, total, handle, status, variantCount?, mediaCount? }
 *   error          — { index, total, handle, msg }
 *   done           — { summary: { created, skipped, errors } }
 *   fatal          — { msg }
 */
function handleSseEvent(data) {
  switch (data.type) {

    case 'start':
      app.importStats.total = data.total;
      updateProgressBar();
      addLogLine('info', '▶', `Import started — ${data.total} product${data.total !== 1 ? 's' : ''} queued`);
      break;

    case 'log': {
      const lvl  = data.level === 'success' ? 'success' : data.level === 'warn' ? 'warn' : 'info';
      const icon = data.level === 'success' ? '✓' : data.level === 'warn' ? '⚠' : '—';
      addLogLine(lvl, icon, data.msg);
      break;
    }

    case 'product_start':
      addLogLine('info', '▷', `[${data.index}/${data.total}] ${data.title}`, data.handle);
      break;

    case 'step': {
      let msg = data.step;
      if (data.step === 'productSet') {
        msg = `productSet — ${data.variantCount} variant${data.variantCount !== 1 ? 's' : ''} created`;
      } else if (data.step === 'media') {
        msg = `media — ${data.mediaCount} image${data.mediaCount !== 1 ? 's' : ''} attached`;
      } else if (data.step === 'inventory') {
        msg = `inventory — ${data.itemsSet} quantities set`;
      }
      addLogLine('success', '✓', `[${data.index}/${data.total}] ${msg}`);
      break;
    }

    // Fires from loader.mjs onProgress when a product is already in Shopify
    case 'skipped':
      addLogLine('warn', '⊘',
        `[${data.index ?? '?'}/${data.total ?? '?'}] SKIPPED — ${data.reason ?? 'already exists in Shopify'}`,
        data.handle);
      break;

    case 'product_done': {
      if (data.status === 'created') {
        app.importStats.created++;
        // Visually mark the row as imported — badge turns to "Imported" (match colour)
        const row = D.auditTbody.querySelector(`tr[data-handle="${CSS.escape(data.handle)}"]`);
        if (row) {
          row.classList.add('row-imported');
          const badge = row.querySelector('.badge');
          if (badge) { badge.className = 'badge badge-match'; badge.textContent = 'Imported'; }
          // Uncheck the row so it won't be accidentally re-queued
          const cb = row.querySelector('.row-check');
          if (cb) cb.checked = false;
        }
      } else {
        app.importStats.skipped++;
      }
      syncMasterCheckbox();
      syncImportButton();
      updateProgressBar();
      break;
    }

    case 'error':
      app.importStats.errors++;
      addLogLine('error', '✗',
        `[${data.index}/${data.total}] ${data.msg}`,
        data.handle);
      updateProgressBar();
      break;

    case 'done': {
      const { created, skipped, errors } = data.summary;
      addLogLine('success', '◎',
        `Done — ${created} created · ${skipped} skipped · ${errors} error${errors !== 1 ? 's' : ''}`);
      endImport();
      loadHistory(); // refresh history panel to show this run
      break;
    }

    case 'fatal':
      addLogLine('error', '✗', `FATAL: ${data.msg}`);
      endImport();
      break;

    default:
      // Unrecognised event type — log silently
      console.debug('[SSE] unknown event type:', data.type, data);
  }
}

function startImport() {
  if (app.importRunning) return;

  const handles = [...document.querySelectorAll('.row-check:not(:disabled):checked')]
    .map(cb => cb.dataset.handle)
    .filter(Boolean);

  if (!handles.length) return;

  app.importRunning = true;
  resetProgressPanel();

  // Update button state: disable import, reveal cancel
  D.btnImport.disabled = true;
  D.btnImport.innerHTML = 'Importing…';
  if (D.btnCancelImport) D.btnCancelImport.removeAttribute('hidden');

  addLogLine('info', '▶', `Connecting to stream for ${handles.length} product${handles.length !== 1 ? 's' : ''}…`);

  const url = `/api/import/stream?handles=${handles.join(',')}`;
  const source = new EventSource(url);
  app.importSource = source;

  source.onmessage = (e) => {
    try {
      handleSseEvent(JSON.parse(e.data));
    } catch (parseErr) {
      addLogLine('warn', '⚠', `Could not parse SSE event: ${parseErr.message}`);
    }
  };

  // onerror fires when the connection closes unexpectedly.
  // If we already called endImport() (e.g. after receiving 'done'),
  // importRunning will be false and we skip the error log.
  source.onerror = () => {
    if (app.importRunning) {
      addLogLine('error', '✗', 'SSE connection lost unexpectedly.');
      endImport();
    }
  };
}

function cancelImport() {
  if (app.importSource) {
    app.importSource.close();
    app.importSource = null;
  }
  addLogLine('warn', '⊘', 'Import cancelled by user.');
  endImport();
}

function endImport() {
  app.importRunning = false;

  // Close SSE if it's still open (e.g. fatal error path)
  if (app.importSource) {
    app.importSource.close();
    app.importSource = null;
  }

  // Restore button state
  D.btnImport.innerHTML = `Import Selected <span id="selected-count">(0)</span>`;
  if (D.btnCancelImport) D.btnCancelImport.setAttribute('hidden', '');

  syncImportButton(); // re-reads #selected-count from the freshly-rendered span
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. HISTORY
// ─────────────────────────────────────────────────────────────────────────────

async function loadHistory() {
  try {
    const runs = await fetchJson('/api/history');
    renderHistory(runs);
  } catch (err) {
    // Non-fatal — silently log, don't break the rest of the UI
    console.warn('[history] load failed:', err.message);
  }
}

function renderHistory(runs) {
  D.historyCount.textContent = String(runs.length);

  if (!runs.length) {
    D.historyTbody.innerHTML = `
      <tr>
        <td colspan="7" class="text-muted" style="text-align:center;padding:12px 16px;font-size:12px">
          No import history yet — run an import to see results here.
        </td>
      </tr>`;
    return;
  }

  D.historyTbody.innerHTML = runs.map(run => {
    const hasErrors  = (run.errors  ?? 0) > 0;
    const hasCreated = (run.created ?? 0) > 0;

    const badgeClass = hasErrors  ? 'badge-conflict'
                     : hasCreated ? 'badge-new'
                     :              'badge-match';
    const badgeText  = hasErrors  ? 'Partial'
                     : hasCreated ? 'Complete'
                     :              'Empty';

    return `
      <tr>
        <td class="hist-id">${esc(run.runId ?? '—')}</td>
        <td class="hist-ts">${esc(fmtTs(run.timestamp))}</td>
        <td class="text-ok  mono">${run.created ?? 0}</td>
        <td class="text-warn mono">${run.skipped ?? 0}</td>
        <td class="${(run.errors ?? 0) > 0 ? 'text-err' : ''} mono">${run.errors ?? 0}</td>
        <td><span class="badge ${badgeClass}">${badgeText}</span></td>
        <td class="hist-ts">${esc(fmtDur(run.durationMs))}</td>
      </tr>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. BOOT
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  cacheDOM();

  // ── Static event listeners ─────────────────────────────────────────────────

  D.btnRefreshToken.addEventListener('click', tokenRefresh);
  D.btnPreview.addEventListener('click', loadPreview);
  D.btnImport.addEventListener('click', startImport);
  D.btnClearLog.addEventListener('click', () => { D.progressLog.innerHTML = ''; });
  D.btnFilter.addEventListener('click', cycleFilter);

  // Cancel import (button lives next to Import Selected in the header)
  D.btnCancelImport?.addEventListener('click', cancelImport);

  // Master checkbox
  D.chkMaster.addEventListener('change', () => {
    document.querySelectorAll('.row-check:not(:disabled)').forEach(cb => {
      cb.checked = D.chkMaster.checked;
    });
    syncImportButton();
  });

  // Select All toolbar button
  D.btnSelectAll.addEventListener('click', () => {
    const all = [...document.querySelectorAll('.row-check:not(:disabled)')];
    const anyUnchecked = all.some(c => !c.checked);
    all.forEach(cb => { cb.checked = anyUnchecked; });
    D.chkMaster.checked = anyUnchecked;
    D.chkMaster.indeterminate = false;
    syncImportButton();
  });

  // Modal
  D.modalClose.addEventListener('click', closeModal);
  D.modalBackdrop.addEventListener('click', closeModal);
  D.btnModalSkip.addEventListener('click', closeModal);
  D.btnModalAck.addEventListener('click', acknowledgeAndSelect);
  D.btnSaveOverrides?.addEventListener('click', saveOverrides);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  // ── Bootstrap sequence ─────────────────────────────────────────────────────

  resetProgressPanel();            // clean slate for stats + log
  await loadPreflight();           // live token + CSV + location check
  await loadPreview();             // CSV parse → transform → Shopify diff
  await loadHistory();             // past import runs
});
