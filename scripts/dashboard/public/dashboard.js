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
// productCategory stores the full GID; display only the numeric node ID so the
// pane stays readable (e.g. "Node 328" instead of the full gid:// URI).
const DIFF_FIELDS = [
  { key: 'title',           label: 'Title',        fmt: v => v },
  { key: 'variantCount',    label: 'Variants',     fmt: v => `${v} variant${v !== 1 ? 's' : ''}` },
  { key: 'priceRange',      label: 'Price Range',  fmt: v => `HK$ ${v}` },
  { key: 'imageCount',      label: 'Images',       fmt: v => `${v} image${v !== 1 ? 's' : ''}` },
  { key: 'productType',     label: 'Product Type', fmt: v => v },
  { key: 'status',          label: 'Status',       fmt: v => v },
  { key: 'productCategory', label: 'Category',     fmt: v => v ? `Node ${String(v).split('/').pop()}` : '— not set —' },
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
    overrideDescription: $('override-description'),

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

    // Modal — Category Metafields (Section 2.5, collapsible)
    cmfDetails:  $('cmf-details'),
    cmfBadge:    $('cmf-badge'),
    cmfBody:     $('cmf-body'),

    // Modal — Variant Explorer (Section 3, collapsible)
    variantExplorerDetails: $('variant-explorer-details'),
    variantCountBadge:      $('variant-count-badge'),
    variantExplorerWrap:    $('variant-explorer-wrap'),

    // Modal — Auto-Assigned Collections display + manual Tags input
    collectionChips:   $('collection-chips'),
    overrideTags:      $('override-tags'),

    // Modal — Taxonomy Category input
    overrideCategory: $('override-category'),

    // History run modal
    historyRunModal:         $('history-run-modal'),
    historyRunModalBackdrop: $('history-modal-backdrop'),
    historyRunModalClose:    $('history-modal-close'),
    historyRunModalOk:       $('history-modal-ok'),
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

  // Inspect button — all rows (conflict-row click is additive for keyboard users)
  D.auditTbody.querySelectorAll('.btn-inspect').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); openModal(btn.dataset.handle); });
  });

  D.auditTbody.querySelectorAll('.conflict-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('input, button')) return;
      openModal(row.dataset.handle);
    });
  });

  // Variant tooltip
  D.auditTbody.querySelectorAll('.variant-count-btn').forEach(btn => {
    btn.addEventListener('mouseenter', showVariantTooltip);
    btn.addEventListener('mouseleave', hideVariantTooltip);
    btn.addEventListener('mousemove',  positionVariantTooltip);
  });

  syncMasterCheckbox();
  syncImportButton();
}

function renderRow(p) {
  const isNew      = p.status === 'new';
  const isConflict = p.status === 'conflict';
  const isMatch    = p.status === 'match';

  // NEW → pre-checked; CONFLICT/MATCH → unchecked but selectable (user can force re-import)
  const checked  = isNew ? 'checked' : '';
  const rowClass = [isConflict ? 'conflict-row' : '', isMatch ? 'match-row' : ''].filter(Boolean).join(' ');

  // Human-readable Shopify Store Status badges
  const badgeClass = isNew      ? 'badge-ready'
                   : isConflict ? 'badge-conflict'
                   :              'badge-in-store';
  const badgeLabel = isNew      ? 'Ready to Import'
                   : isConflict ? 'Conflict'
                   :              'In Store';

  // Price: single value or min–max range
  const pMin = Math.round(p.priceMin ?? 0);
  const pMax = Math.round(p.priceMax ?? 0);
  const priceDisplay = pMin === pMax ? `HK$${pMin}` : `HK$${pMin}–${pMax}`;

  // Thumbnail — graceful no-image fallback
  const imgCell = p.imageUrl
    ? `<img src="${esc(p.imageUrl)}" alt="${esc(p.title)}" class="thumb" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'thumb-placeholder'}))">`
    : '<span class="thumb-placeholder"></span>';

  // Variant cell — shows count badge + breakdown; style list surfaced via JS tooltip on hover
  const stylesAttr = Array.isArray(p.styleOptions) && p.styleOptions.length
    ? ` data-styles="${esc(p.styleOptions.join('|'))}"`
    : '';
  const mathHtml = p.modelCount && p.styleCount
    ? `<small class="variant-math">${p.modelCount}×${p.styleCount}</small>`
    : '';
  const variantCell =
    `<button class="variant-count-btn" data-handle="${esc(p.handle)}"${stylesAttr} tabindex="-1" aria-label="Hover to see style variants">
       <span class="variant-badge">${p.variantCount}</span>
       ${mathHtml}
     </button>`;

  // Phase 1 fallback indicator — shown when smart defaults were applied
  const fallbackHtml = Array.isArray(p.fallbacksApplied) && p.fallbacksApplied.length
    ? `<span class="fallback-badge-inline" title="Auto-filled by smart fallback: ${esc(p.fallbacksApplied.join(', '))}">⚠ Fallback</span>`
    : '';

  // Inspect button — visible on hover for ALL row types
  const actionCell =
    `<button class="btn btn-ghost btn-sm btn-inspect btn-inspect-all" data-handle="${esc(p.handle)}" aria-label="Inspect product">Inspect</button>`;

  return `
    <tr data-status="${p.status}" data-handle="${esc(p.handle)}" class="${rowClass}">
      <td class="col-img">${imgCell}</td>
      <td class="col-check">
        <input type="checkbox" class="row-check" data-handle="${esc(p.handle)}" ${checked}>
      </td>
      <td><span class="badge ${badgeClass}">${badgeLabel}</span></td>
      <td class="col-title" title="${esc(p.etsyTitle ?? p.title)}">
        <div class="title-text">${esc(p.title)}${fallbackHtml}</div>
      </td>
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

// ── Variant tooltip ───────────────────────────────────────────────────────────

let _tooltip = null;

function getTooltip() {
  if (!_tooltip) {
    _tooltip = document.createElement('div');
    _tooltip.id = 'variant-tooltip';
    document.body.appendChild(_tooltip);
  }
  return _tooltip;
}

function showVariantTooltip(e) {
  const btn    = e.currentTarget;
  const raw    = btn.dataset.styles ?? '';
  const styles = raw ? raw.split('|') : [];
  const handle = btn.dataset.handle ?? '';
  const product = app.productMap.get(handle);

  const tt = getTooltip();

  const chipsHtml = styles.length
    ? `<div class="vt-tooltip-chips">${styles.map(s => `<span class="vt-tooltip-chip">${esc(s)}</span>`).join('')}</div>`
    : '<span style="color:var(--muted);font-size:11px">No style variants</span>';

  const mathLine = product?.modelCount && product?.styleCount
    ? `<div class="vt-tooltip-math">${product.modelCount} models × ${product.styleCount} styles = ${product.variantCount} variants</div>`
    : '';

  tt.innerHTML = `
    <div class="vt-tooltip-label">Style Options</div>
    ${chipsHtml}
    ${mathLine}`;

  positionVariantTooltip(e);
  tt.classList.add('visible');
}

function hideVariantTooltip() {
  _tooltip?.classList.remove('visible');
}

function positionVariantTooltip(e) {
  if (!_tooltip) return;
  const gap = 12;
  const tt  = _tooltip;
  const ttW = tt.offsetWidth  || 220;
  const ttH = tt.offsetHeight || 80;
  let left  = e.clientX + gap;
  let top   = e.clientY - ttH / 2;

  if (left + ttW > window.innerWidth  - 8) left = e.clientX - ttW - gap;
  if (top  < 8)                            top  = 8;
  if (top  + ttH > window.innerHeight - 8) top  = window.innerHeight - ttH - 8;

  tt.style.left = `${left}px`;
  tt.style.top  = `${top}px`;
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

  // ── Section 2.5: Category Metafields ─────────────────────────────────────
  // Pass undefined explicitly when the field is absent so the stale-cache path fires.
  renderCategoryMetafields(product.categoryMetafields);

  // ── Section 3: Variant Explorer — always collapsed on open, loads async ───
  if (D.variantExplorerDetails) D.variantExplorerDetails.open = false;
  renderVariantExplorer(handle); // non-blocking: modal opens while table fetches

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

/**
 * Render the read-only Auto-Assigned Collections chip list.
 * Each chip shows the collection label and is colour-coded by level tier.
 * Hovering reveals the full Shopify GID (placeholder or real).
 *
 * @param {Array<{gid:string, label:string, level:number, handle:string}>} collections
 */
function renderCollectionChips(collections) {
  if (!D.collectionChips) return;
  if (!Array.isArray(collections) || collections.length === 0) {
    D.collectionChips.replaceChildren(
      Object.assign(document.createElement('span'), {
        className:   'collection-chips-empty',
        textContent: '— none assigned',
      })
    );
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const col of collections) {
    const chip = document.createElement('span');
    const todoClass = col.live === false ? ' collection-chip-todo' : '';
    chip.className   = `collection-chip collection-chip-level-${col.level}${todoClass}`;
    chip.textContent = col.live === false ? `${col.label} 🔲` : col.label;
    // Show full GID on hover — useful to verify live IDs / track pending ones
    chip.title       = col.live === false
      ? `🔲 Collection not yet created — create "${col.handle}" in Shopify Admin to activate`
      : col.gid;
    fragment.appendChild(chip);
  }
  D.collectionChips.replaceChildren(fragment);
}

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
  // Description: use the per-product bodyHtml stored in productMap (may have
  // been previously edited by the user).  Falls back to an empty string so the
  // placeholder is visible on first open before the preview cache is warmed.
  if (D.overrideDescription) D.overrideDescription.value = product.bodyHtml ?? '';

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

  // ── Auto-Assigned Collections chips ───────────────────────────────────────
  renderCollectionChips(product.collections ?? []);

  // ── Tags input — clear on each open so the field only holds NEW additions.
  // The full auto-assigned tag list (30+ taxonomy tags) is managed server-side;
  // this input exists solely for manual extras the user wants to bolt on.
  if (D.overrideTags) D.overrideTags.value = '';

  // ── Taxonomy Category — pre-fill from productMap (persists edits across opens)
  if (D.overrideCategory) D.overrideCategory.value = product.productCategory ?? '';
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

/**
 * Fetch the full post-pruning variant list from the server and render it into
 * the Section 3 Variant Explorer table.
 *
 * This is called on every openModal() — it fires asynchronously so the modal
 * opens immediately while the table data loads in the background.
 *
 * Columns:  Model · Style  |  SKU  |  Price (HKD)
 *
 * @param {string} handle
 */
/**
 * Render the Category Metafields section in the Product Inspector modal.
 *
 * @param {Array<{key:string, name:string, values:string[]}>|undefined} metafields
 *   Resolved display objects returned by the server's resolveCategoryMetafieldsForDisplay().
 *   undefined  → server cache is stale (preview needs to be reloaded)
 *   []         → pipeline produced no metafields for this product
 *   [...]      → filled metafields ready to display
 */
function renderCategoryMetafields(metafields) {
  if (!D.cmfBody || !D.cmfBadge || !D.cmfDetails) return;

  // undefined means the preview cache predates this feature — ask the user to reload
  if (metafields === undefined) {
    D.cmfBadge.textContent = 'Stale cache';
    D.cmfBadge.className   = 'diff-badge cmf-badge-stale';
    D.cmfBody.innerHTML    = `
      <div class="cmf-empty">
        <span class="cmf-empty-icon">⟳</span>
        <span class="cmf-empty-text">
          Preview cache is outdated. Click <strong>Reload Preview</strong> in the toolbar
          to rebuild the payload — metafields will appear here automatically.
        </span>
      </div>`;
    D.cmfDetails.open = true;
    return;
  }

  if (!metafields.length) {
    D.cmfBadge.textContent = '0 filled';
    D.cmfBadge.className   = 'diff-badge no-diffs';
    D.cmfBody.innerHTML    = `
      <div class="cmf-empty">
        <span class="cmf-empty-icon">◎</span>
        <span class="cmf-empty-text">
          No category metafields detected for this product.
          The classifier found no matching signals (material, case type, features, etc.)
          in the title or tags.
        </span>
      </div>`;
    // Collapse when empty so the modal isn't noisy
    D.cmfDetails.open = false;
    return;
  }

  D.cmfBadge.textContent = `${metafields.length} filled`;
  D.cmfBadge.className   = 'diff-badge cmf-badge-filled';

  // Render one row per resolved metafield attribute
  const rows = metafields.map(({ key, name, values }) => {
    const chips = values
      .map(v => `<span class="cmf-value-chip" title="${esc(key)}">${esc(v)}</span>`)
      .join('');
    return `
      <div class="cmf-row">
        <div class="cmf-attr-name">${esc(name)}</div>
        <div class="cmf-attr-values">${chips}</div>
      </div>`;
  }).join('');

  D.cmfBody.innerHTML = `
    <div class="cmf-intro">
      These Shopify taxonomy attributes will be set as <code>shopify</code> namespace metafields
      on every product. Values are resolved from the classifier output.
    </div>
    <div class="cmf-grid">${rows}</div>`;

  // Auto-expand when there is data
  D.cmfDetails.open = true;
}

// Custom sort weight — bundles ordered by complexity, not alphabetically.
// Strap variants are not carried — any that arrive from the CSV are
// auto-converted to their grip equivalents during the transform pipeline.
const STYLE_WEIGHT = {
  'Case+Grip+Charm': 1,
  'Case+Grip':       2,
  'Case+Charm':      3,
  'Case Only':       4,
  'Grip Only':       5,
  'Charm Only':      6,
};

// Canonical ordered style list — mirrors STYLE_PRICES keys in transform.mjs.
// Used by the Style Remapper and Add Style dropdowns.
const ALL_VALID_STYLES = Object.keys(STYLE_WEIGHT);

async function renderVariantExplorer(handle) {
  if (!D.variantExplorerWrap) return;

  // Persist sort mode across re-renders via dataset on the wrapper element
  const sortMode = D.variantExplorerWrap.dataset.sortMode || 'model';

  // Reset badge and show spinner-style placeholder
  if (D.variantCountBadge) {
    D.variantCountBadge.textContent = '…';
    D.variantCountBadge.className   = 'diff-badge no-diffs';
  }
  D.variantExplorerWrap.innerHTML = '<div class="vt-placeholder vt-loading">Loading variants…</div>';

  try {
    const data = await fetchJson(`/api/product/${encodeURIComponent(handle)}/variants`);

    // Store total variant count for removal-delta calculation; get removed set
    const product    = app.productMap.get(handle) ?? {};
    product._allVariantCount = data.count;
    if (product !== null) app.productMap.set(handle, product);

    const removedSet   = new Set(product._removedSkus ?? []);
    const removedCount = removedSet.size;
    const activeCount  = data.count - removedCount;

    if (D.variantCountBadge) {
      D.variantCountBadge.textContent = `${activeCount} variant${activeCount !== 1 ? 's' : ''}`;
      D.variantCountBadge.className   = 'diff-badge';
    }

    if (!data.variants.length) {
      D.variantExplorerWrap.innerHTML = '<div class="vt-placeholder">No variants found for this product.</div>';
      return;
    }

    // Build style frequency map for the Style Remapper panel
    const styleCountMap = {};
    data.variants.forEach(v => { styleCountMap[v.style] = (styleCountMap[v.style] || 0) + 1; });
    const uniqueStyles = Object.keys(styleCountMap);

    // Sort variants by the active sort mode
    const sortedVariants = [...data.variants].sort((a, b) => {
      if (sortMode === 'style') {
        const sw = (STYLE_WEIGHT[a.style] ?? 99) - (STYLE_WEIGHT[b.style] ?? 99);
        return sw !== 0 ? sw : a.model.localeCompare(b.model);
      }
      // Default: group by model, then by style weight within each model
      const mc = a.model.localeCompare(b.model);
      return mc !== 0 ? mc : (STYLE_WEIGHT[a.style] ?? 99) - (STYLE_WEIGHT[b.style] ?? 99);
    });

    // Group-change detection based on the primary sort key
    const groupKey  = v => sortMode === 'style' ? v.style : v.model;
    let   lastGroup = null;
    const rows = sortedVariants.map(v => {
      const groupChanged = groupKey(v) !== lastGroup;
      lastGroup = groupKey(v);
      const isDeleted  = removedSet.has(v.sku);
      const rowClass   = [groupChanged ? 'vt-model-start' : '', isDeleted ? 'vt-deleted' : ''].filter(Boolean).join(' ');
      const deleteTip  = isDeleted ? 'Restore this variant' : 'Remove this variant before import';
      const deleteIcon = isDeleted ? '↩' : '✕';
      return `
        <tr class="${rowClass}" data-sku="${esc(v.sku)}">
          <td class="vt-name">
            <span class="vt-model">${esc(v.model)}</span>
            <span class="vt-sep">·</span>
            <span class="vt-style">${esc(v.style)}</span>
          </td>
          <td class="vt-sku-cell"><code class="vt-sku">${esc(v.sku)}</code></td>
          <td class="vt-price">HK$${v.price.toFixed(2)}</td>
          <td style="width:40px;text-align:center">
            <button class="vt-delete-btn" data-sku="${esc(v.sku)}" title="${esc(deleteTip)}">${deleteIcon}</button>
          </td>
        </tr>`;
    }).join('');

    // Build sort-toggle UI — NO inline onclick (double-quote injection breaks HTML attrs).
    // Buttons are identified by data-sort attribute; listeners wired after innerHTML.
    const activeStyle = 'background:var(--accent);color:#fff;border-color:var(--accent)';
    const dimStyle    = 'opacity:.55';

    // Build Style Remapper panel rows — one row per unique style currently on this product.
    // Each select includes:
    //   • All other valid styles (rename)
    //   • A sentinel "✕ Remove this style" option (deletes all variants of that style)
    const remapRowsHtml = uniqueStyles.map(style => {
      const count      = styleCountMap[style];
      const renameOpts = ALL_VALID_STYLES
        .filter(s => s !== style)
        .map(s => `<option value="${esc(s)}">${esc(s)}</option>`)
        .join('');
      return `
        <div class="vt-remap-row">
          <div class="vt-remap-from-wrap">
            <span class="vt-remap-from-name">${esc(style)}</span>
            <span class="vt-remap-count">${count}×</span>
          </div>
          <span class="vt-remap-arrow">→</span>
          <select class="vt-remap-select" data-from="${esc(style)}">
            <option value="">— keep as-is —</option>
            ${renameOpts}
            <option value="__REMOVE__" class="vt-remap-opt-remove">✕  Remove this style</option>
          </select>
        </div>`;
    }).join('');

    // "Add Style" section — only lists styles NOT already on the product
    const addableStyles = ALL_VALID_STYLES.filter(s => !styleCountMap[s]);
    const addStyleOpts  = addableStyles
      .map(s => `<option value="${esc(s)}">${esc(s)}</option>`)
      .join('');
    const addStyleHtml = addableStyles.length
      ? `<div class="vt-add-style-section">
           <div class="vt-add-style-label">Add a style</div>
           <div class="vt-add-style-row">
             <select class="vt-add-style-select" id="vt-add-style-select">
               <option value="">— select style to add —</option>
               ${addStyleOpts}
             </select>
             <button class="btn btn-ghost btn-sm vt-add-style-btn" id="vt-add-style-btn"
               title="Generate new variants for all current phone models with this style">
               + Add Style
             </button>
           </div>
         </div>`
      : '';

    D.variantExplorerWrap.innerHTML = `
      <div class="vt-toolbar">
        <button class="btn btn-ghost btn-sm" data-sort="model"
          style="${sortMode === 'model' ? activeStyle : dimStyle}">
          Group by Phone Model
        </button>
        <button class="btn btn-ghost btn-sm" data-sort="style"
          style="${sortMode === 'style' ? activeStyle : dimStyle}">
          Group by Style
        </button>
        <div class="vt-toolbar-spacer"></div>
        <button class="btn btn-ghost btn-sm vt-edit-styles-btn" id="vt-edit-styles-btn"
          title="Rename, remove, or add style options">
          ✎ Edit Styles
          <span class="vt-edit-styles-count">${uniqueStyles.length}</span>
        </button>
      </div>

      <div class="vt-style-remap-panel" id="vt-style-remap-panel" hidden>
        <div class="vt-remap-header">
          <span class="vt-remap-title">Edit Style Options</span>
          <span class="vt-remap-hint">Rename or remove a style across all variants in one operation. SKU suffixes and prices update automatically.</span>
        </div>
        <div class="vt-remap-rows">${remapRowsHtml}</div>
        <div class="vt-remap-footer">
          <button class="btn btn-ghost btn-sm" id="vt-remap-cancel-btn">Cancel</button>
          <button class="btn btn-primary btn-sm" id="vt-remap-apply-btn">Apply Changes</button>
        </div>
        ${addStyleHtml}
      </div>

      <table class="variant-table">
        <colgroup>
          <col class="vt-col-name">
          <col class="vt-col-sku">
          <col class="vt-col-price">
          <col style="width:40px">
        </colgroup>
        <thead>
          <tr>
            <th class="vt-name">${sortMode === 'style' ? 'Style · Model' : 'Model · Style'}</th>
            <th class="vt-sku-cell">SKU</th>
            <th class="vt-price">Price</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;

    // Wire sort-toggle buttons — safe event delegation, no inline onclick
    D.variantExplorerWrap.querySelectorAll('[data-sort]').forEach(btn => {
      btn.addEventListener('click', () => {
        D.variantExplorerWrap.dataset.sortMode = btn.dataset.sort;
        renderVariantExplorer(handle);
      });
    });

    // Wire delete/restore buttons
    D.variantExplorerWrap.querySelectorAll('.vt-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => toggleVariantRemoval(handle, btn.dataset.sku));
    });

    // Wire Style Remapper panel
    const editStylesBtn = D.variantExplorerWrap.querySelector('#vt-edit-styles-btn');
    const remapPanel    = D.variantExplorerWrap.querySelector('#vt-style-remap-panel');

    if (editStylesBtn && remapPanel) {
      editStylesBtn.addEventListener('click', () => {
        const isOpen = !remapPanel.hasAttribute('hidden');
        remapPanel.toggleAttribute('hidden', isOpen);
        editStylesBtn.classList.toggle('vt-edit-styles-active', !isOpen);
      });

      D.variantExplorerWrap.querySelector('#vt-remap-cancel-btn')
        ?.addEventListener('click', () => {
          remapPanel.setAttribute('hidden', '');
          editStylesBtn.classList.remove('vt-edit-styles-active');
          // Reset all selects + clear remove tint
          remapPanel.querySelectorAll('.vt-remap-select').forEach(s => {
            s.value = '';
            s.dataset.removing = 'false';
          });
        });

      D.variantExplorerWrap.querySelector('#vt-remap-apply-btn')
        ?.addEventListener('click', () => applyStyleRemaps(handle, remapPanel, editStylesBtn));

      // Visual feedback: tint the select row red when "Remove" is chosen
      remapPanel.querySelectorAll('.vt-remap-select').forEach(sel => {
        sel.addEventListener('change', () => {
          sel.dataset.removing = sel.value === '__REMOVE__' ? 'true' : 'false';
        });
      });

      // "+ Add Style" button — generates new variants (all current models × new style)
      D.variantExplorerWrap.querySelector('#vt-add-style-btn')
        ?.addEventListener('click', () => {
          const sel = D.variantExplorerWrap.querySelector('#vt-add-style-select');
          if (sel?.value) addStyleToProduct(handle, sel.value);
        });
    }

  } catch (err) {
    D.variantExplorerWrap.innerHTML = `<div class="vt-placeholder vt-error">⚠ ${esc(err.message)}</div>`;
    if (D.variantCountBadge) {
      D.variantCountBadge.textContent = 'Error';
      D.variantCountBadge.className   = 'diff-badge';
    }
  }
}

/**
 * Toggle a variant's removal status for the given product handle.
 * Updates the in-memory productMap, re-styles the row, and sends removedSkus
 * to the server so the import payload reflects the deletion.
 */
function toggleVariantRemoval(handle, sku) {
  const product = app.productMap.get(handle);
  if (!product) return;

  const removed = new Set(product._removedSkus ?? []);
  if (removed.has(sku)) {
    removed.delete(sku);
  } else {
    removed.add(sku);
  }
  product._removedSkus = [...removed];
  app.productMap.set(handle, product);

  // Visually toggle the row
  const row = D.variantExplorerWrap?.querySelector(`tr[data-sku="${CSS.escape(sku)}"]`);
  if (row) {
    const isNowDeleted = removed.has(sku);
    row.classList.toggle('vt-deleted', isNowDeleted);
    const btn = row.querySelector('.vt-delete-btn');
    if (btn) {
      btn.textContent = isNowDeleted ? '↩' : '✕';
      btn.title       = isNowDeleted ? 'Restore this variant' : 'Remove this variant before import';
    }
  }

  // Update the variant count badge
  const activeCount = (app.productMap.get(handle)?._allVariantCount ?? 0) - removed.size;
  if (D.variantCountBadge) {
    D.variantCountBadge.textContent = `${activeCount} variant${activeCount !== 1 ? 's' : ''}`;
  }

  // Push to server
  fetchJson(`/api/product/${encodeURIComponent(handle)}/override`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ removedSkus: [...removed] }),
  })
    .then(r => addLogLine('success', '✓', `Variant list updated: ${r.variantCount} variants remaining`, handle))
    .catch(err => addLogLine('error', '✗', `Variant update failed: ${err.message}`, handle));
}

/**
 * Bulk-remap one or more style names across all variants of a product.
 *
 * Reads the remap panel's <select> elements, collects all non-empty selections
 * as { from, to } pairs, posts them to the server, then re-renders the
 * Variant Explorer so the updated styles/SKUs/prices are immediately visible.
 *
 * The server handles:
 *  - Renaming the style optionValue on each affected variant
 *  - Recalculating the SKU suffix (e.g. CG → CC)
 *  - Recalculating the variant price from the canonical STYLE_PRICES matrix
 *  - Deduplicating variants when a remap merges two existing styles
 *  - Updating productOptions.Style values for the import payload
 *
 * @param {string}      handle
 * @param {HTMLElement} remapPanel     — the .vt-style-remap-panel element
 * @param {HTMLElement} editStylesBtn  — the ✎ Edit Styles toggle button
 */
async function applyStyleRemaps(handle, remapPanel, editStylesBtn) {
  // Collect only the selects that have a non-default value chosen
  const remaps = [];
  remapPanel.querySelectorAll('.vt-remap-select').forEach(sel => {
    if (sel.value) remaps.push({ from: sel.dataset.from, to: sel.value });
  });

  if (!remaps.length) {
    addLogLine('warn', '⚠', 'No style changes selected — choose a replacement from the dropdowns first.', handle);
    return;
  }

  const applyBtn = remapPanel.querySelector('#vt-remap-apply-btn');
  if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = 'Applying…'; }

  try {
    const result = await fetchJson(`/api/product/${encodeURIComponent(handle)}/override`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ styleRemaps: remaps }),
    });

    const summary = remaps
      .map(r => r.to === '__REMOVE__' ? `removed "${r.from}"` : `"${r.from}" → "${r.to}"`)
      .join(', ');
    addLogLine('success', '✓',
      `Styles updated: ${summary} · ${result.variantCount} variant${result.variantCount !== 1 ? 's' : ''} remaining`,
      handle);

    // Re-render the Variant Explorer so updated styles/SKUs are reflected
    renderVariantExplorer(handle);

  } catch (err) {
    addLogLine('error', '✗', `Style remap failed: ${err.message}`, handle);
    if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = 'Apply Remaps'; }
  }
}

/**
 * Add a brand-new style to a product by generating one variant for every
 * current phone model × the requested style.
 *
 * The server:
 *  - Infers the SKU char code from the product's existing variants
 *  - Builds new variants: Y2K-{CHAR}-{MODEL}-{STYLE_CODE}
 *  - Assigns the canonical STYLE_PRICES price for the new style
 *  - Appends the style to productOptions.Style.values
 *  - Is idempotent — calling twice for the same style is a no-op
 *
 * @param {string} handle
 * @param {string} styleName — must be a value from ALL_VALID_STYLES
 */
async function addStyleToProduct(handle, styleName) {
  const addBtn = D.variantExplorerWrap?.querySelector('#vt-add-style-btn');
  if (addBtn) { addBtn.disabled = true; addBtn.textContent = 'Adding…'; }

  try {
    const result = await fetchJson(`/api/product/${encodeURIComponent(handle)}/override`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ addStyles: [styleName] }),
    });

    addLogLine('success', '✓',
      `"${styleName}" added — ${result.variantCount} variant${result.variantCount !== 1 ? 's' : ''} total`,
      handle);

    // Re-render so the new variants and updated "Add Style" dropdown are visible
    renderVariantExplorer(handle);

  } catch (err) {
    addLogLine('error', '✗', `Add style failed: ${err.message}`, handle);
    if (addBtn) { addBtn.disabled = false; addBtn.textContent = '+ Add Style'; }
  }
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
  const newBodyHtml    = D.overrideDescription?.value ?? null;
  const newCategory    = (D.overrideCategory?.value ?? '').trim();
  const additionalTags = (D.overrideTags?.value ?? '')
    .split(',')
    .map(t => t.trim().toLowerCase())
    .filter(Boolean);

  // Build a diff patch — only include fields that actually changed
  const patch = {};
  if (newTitle       && newTitle !== product.title)                              patch.title           = newTitle;
  if (newProductType && newProductType !== product.collection)                   patch.productType     = newProductType;
  if (!isNaN(newBasePrice) && newBasePrice > 0 &&
      Math.abs(newBasePrice - (product.priceMin ?? 0)) > 0.005)                 patch.basePrice       = newBasePrice;
  if (newBodyHtml !== null && newBodyHtml !== (product.bodyHtml ?? ''))          patch.bodyHtml        = newBodyHtml;
  if (newCategory  && newCategory !== (product.productCategory ?? ''))           patch.productCategory = newCategory;
  if (additionalTags.length)                                                     patch.tags            = additionalTags;

  if (!Object.keys(patch).length) return null; // nothing changed

  // ── 1. Update client-side productMap (synchronous) ─────────────────────
  const updated = { ...product };
  if (patch.title)                   updated.title           = patch.title;
  if (patch.productType)             updated.collection      = patch.productType;
  if (patch.bodyHtml !== undefined)  updated.bodyHtml        = patch.bodyHtml;
  if (patch.productCategory)         updated.productCategory = patch.productCategory;
  if (patch.tags?.length) {
    // Merge additional tags into existing tag array; deduplicate via Set.
    updated.tags = [...new Set([...(product.tags ?? []), ...patch.tags])];
  }
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

  // Clear the tags input immediately after capture so the same tags aren't
  // re-sent if the user saves again or opens another product.
  if (D.overrideTags) D.overrideTags.value = '';

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

  // cells[3] = Title column — title lives inside .title-text, chips live in .style-option-row
  const titleCell = row.cells[3];
  if (titleCell) {
    const titleDiv = titleCell.querySelector('.title-text');
    const existingBadge = titleCell.querySelector('.fallback-badge-inline');
    if (titleDiv) {
      titleDiv.textContent = product.title;
      if (existingBadge) titleDiv.appendChild(existingBadge);
    }
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
      if (data.status === 'created' || data.status === 'updated') {
        app.importStats.created++;
        // Visually mark the row — badge changes to "Imported" or "Updated"
        const row = D.auditTbody.querySelector(`tr[data-handle="${CSS.escape(data.handle)}"]`);
        if (row) {
          row.classList.add('row-imported');
          const badge = row.querySelector('.badge');
          if (badge) {
            badge.className = 'badge badge-in-store';
            badge.textContent = data.status === 'updated' ? 'Updated' : 'Imported';
          }
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

  D.historyTbody.innerHTML = runs.map((run, idx) => {
    const hasErrors  = (run.errors  ?? 0) > 0;
    const hasCreated = (run.created ?? 0) > 0;

    const badgeClass = hasErrors  ? 'badge-conflict'
                     : hasCreated ? 'badge-ready'
                     :              'badge-in-store';
    const badgeText  = hasErrors  ? 'Partial'
                     : hasCreated ? 'Complete'
                     :              'Empty';

    return `
      <tr style="cursor:pointer" data-run-idx="${idx}" title="Click to view run details">
        <td class="hist-id">${esc(run.runId ?? '—')}</td>
        <td class="hist-ts">${esc(fmtTs(run.timestamp))}</td>
        <td class="text-ok  mono">${run.created ?? 0}</td>
        <td class="text-warn mono">${run.skipped ?? 0}</td>
        <td class="${(run.errors ?? 0) > 0 ? 'text-err' : ''} mono">${run.errors ?? 0}</td>
        <td><span class="badge ${badgeClass}">${badgeText}</span></td>
        <td class="hist-ts">${esc(fmtDur(run.durationMs))}</td>
      </tr>`;
  }).join('');

  // Store runs for click handler access
  app.historyRuns = runs;

  // Wire click on each row → history detail modal
  D.historyTbody.querySelectorAll('tr[data-run-idx]').forEach(row => {
    row.addEventListener('click', () => {
      const run = app.historyRuns?.[parseInt(row.dataset.runIdx, 10)];
      if (run) openHistoryRunModal(run);
    });
  });
}

function openHistoryRunModal(run) {
  const modal   = $('history-run-modal');
  const body    = $('history-modal-body');
  const runIdEl = $('history-modal-runid');
  const noteEl  = $('history-modal-note');
  if (!modal || !body) return;

  runIdEl.textContent = run.runId ?? '—';

  const created = run.created ?? 0;
  const skipped = run.skipped ?? 0;
  const errors  = run.errors  ?? 0;
  const total   = created + skipped + errors;

  noteEl.textContent = `${fmtTs(run.timestamp)} · ${fmtDur(run.durationMs)}`;

  // Stats grid
  const statsHtml = `
    <div class="history-run-stats">
      <div class="stat-box ok" ><div class="stat-label">Created</div><div class="stat-value">${created}</div></div>
      <div class="stat-box warn"><div class="stat-label">Skipped</div><div class="stat-value">${skipped}</div></div>
      <div class="stat-box ${errors > 0 ? 'err' : ''}"><div class="stat-label">Errors</div><div class="stat-value">${errors}</div></div>
      <div class="stat-box"><div class="stat-label">Total</div><div class="stat-value">${total}</div></div>
    </div>`;

  // Product handle list
  const handles = Array.isArray(run.handles) ? run.handles : [];
  const productListHtml = handles.length
    ? `<div class="history-run-products">
         ${handles.map(h => `
           <div class="history-run-product-row">
             <span class="hrp-handle">${esc(h)}</span>
           </div>`).join('')}
       </div>`
    : '<p style="font-size:12px;color:var(--muted);padding:8px 0">No product handle data recorded for this run.</p>';

  body.innerHTML = statsHtml + productListHtml;
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeHistoryRunModal() {
  const modal = $('history-run-modal');
  if (modal) modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
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

  // Conflict Inspector modal
  D.modalClose.addEventListener('click', closeModal);
  D.modalBackdrop.addEventListener('click', closeModal);
  D.btnModalSkip.addEventListener('click', closeModal);
  D.btnModalAck.addEventListener('click', acknowledgeAndSelect);
  D.btnSaveOverrides?.addEventListener('click', saveOverrides);

  // History run detail modal
  D.historyRunModalClose?.addEventListener('click', closeHistoryRunModal);
  D.historyRunModalBackdrop?.addEventListener('click', closeHistoryRunModal);
  D.historyRunModalOk?.addEventListener('click', closeHistoryRunModal);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeModal(); closeHistoryRunModal(); }
  });

  // ── Bootstrap sequence ─────────────────────────────────────────────────────

  resetProgressPanel();            // clean slate for stats + log
  await loadPreflight();           // live token + CSV + location check
  await loadPreview();             // CSV parse → transform → Shopify diff
  await loadHistory();             // past import runs
});
