/**
 * Y2KASE Semantic Deduplication Pipeline
 *
 * Reads all EtsyListingsDownload.csv files from data/raw_sources/, uses the
 * OpenAI API to normalise each product title into a stable canonical slug,
 * groups duplicates across shops by that slug, and writes a single
 * EtsyListingsDownload_Golden.csv using survivorship rules.
 *
 * ── Pipeline Phases ───────────────────────────────────────────────────────────
 *
 *   1. Ingestion      — stream every CSV in data/raw_sources/, tag each row
 *                       with __source_shop so we have full lineage.
 *
 *   2. Normalization  — pass each unique title to gpt-4o-mini (or whatever
 *                       OPENAI_MODEL is set to) which strips SEO filler and
 *                       returns a slugified Canonical Product ID.
 *                       Results are cached to .cache/canonical-ids.json so
 *                       re-runs cost $0 for already-seen titles.
 *
 *   3. Grouping       — group rows in memory by __canonical_id.
 *
 *   4. Survivorship   — for each group of duplicates, build one Golden Record:
 *                         TITLE    → shortest (least-stuffed)
 *                         QUANTITY → sum across all merged rows
 *                         TAGS     → union of all unique tags
 *                         IMAGE*   → deduplicated union, packed into IMAGE1-10
 *                         all else → inherited from the title-winner row
 *
 *   5. Egress         — write data/EtsyListingsDownload_Golden.csv with the
 *                       exact Etsy column order, then print a CLI summary.
 *
 * Usage:
 *   node scripts/semantic-dedupe.mjs
 *   node scripts/semantic-dedupe.mjs --concurrency 10
 *
 * Prerequisites:
 *   - OPENAI_API_KEY set in .env
 *   - One or more EtsyListingsDownload.csv files in data/raw_sources/
 */

import { createHash }                         from 'node:crypto';
import { readFileSync, existsSync }           from 'node:fs';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, dirname, basename }          from 'node:path';
import { fileURLToPath }                       from 'node:url';
import { parseCsvFile }                        from './lib/csv-parser.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Environment ───────────────────────────────────────────────────────────────

function loadEnv(filePath) {
  if (!existsSync(filePath)) return;
  let text = readFileSync(filePath, 'utf-8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq === -1) continue;
    const key = s.slice(0, eq).trim();
    const val = s.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnv(resolve(__dirname, '../.env'));

// ── Config ────────────────────────────────────────────────────────────────────

const OPENAI_KEY   = process.env.OPENAI_API_KEY ?? '';
const OPENAI_MODEL = process.env.OPENAI_MODEL   ?? 'gpt-4o-mini';

// Parse --concurrency N from CLI args, default 8
const concurrencyArg = process.argv.indexOf('--concurrency');
const CONCURRENCY    = concurrencyArg !== -1
  ? Math.max(1, parseInt(process.argv[concurrencyArg + 1], 10) || 8)
  : 8;

// ── Paths ─────────────────────────────────────────────────────────────────────

const RAW_DIR    = resolve(__dirname, '../data/raw_sources');
const OUTPUT_CSV = resolve(__dirname, '../data/EtsyListingsDownload_Golden.csv');
const CACHE_PATH = resolve(__dirname, '../.cache/canonical-ids.json');
const CACHE_DIR  = resolve(__dirname, '../.cache');

// Exact Etsy CSV column order — must match Etsy's export format precisely.
const ETSY_HEADERS = [
  'TITLE',
  'DESCRIPTION',
  'PRICE',
  'CURRENCY_CODE',
  'QUANTITY',
  'TAGS',
  'MATERIALS',
  'IMAGE1', 'IMAGE2', 'IMAGE3', 'IMAGE4', 'IMAGE5',
  'IMAGE6', 'IMAGE7', 'IMAGE8', 'IMAGE9', 'IMAGE10',
  'VARIATION 1 TYPE',
  'VARIATION 1 NAME',
  'VARIATION 1 VALUES',
  'VARIATION 2 TYPE',
  'VARIATION 2 NAME',
  'VARIATION 2 VALUES',
  'SKU',
];

const IMAGE_KEYS = ['IMAGE1','IMAGE2','IMAGE3','IMAGE4','IMAGE5',
                    'IMAGE6','IMAGE7','IMAGE8','IMAGE9','IMAGE10'];

// ── Concurrency Limiter ───────────────────────────────────────────────────────
// Minimal p-limit equivalent — no external dependencies required.

function createLimiter(concurrency) {
  let active = 0;
  const queue = [];

  const pump = () => {
    while (active < concurrency && queue.length > 0) {
      const { fn, resolve, reject } = queue.shift();
      active++;
      fn()
        .then(resolve, reject)
        .finally(() => { active--; pump(); });
    }
  };

  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}

// ── Canonical ID Cache ────────────────────────────────────────────────────────

const CACHE_VERSION = 1;

async function loadCache() {
  try {
    const raw  = await readFile(CACHE_PATH, 'utf-8');
    const data = JSON.parse(raw);
    if (data.version !== CACHE_VERSION) {
      console.info('[cache] Schema version changed — rebuilding cache');
      return { version: CACHE_VERSION, entries: {} };
    }
    return data;
  } catch {
    return { version: CACHE_VERSION, entries: {} };
  }
}

async function saveCache(cache) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
}

/** Stable 16-char fingerprint for a title string. */
function titleKey(title) {
  return createHash('sha256')
    .update(title.trim().toLowerCase())
    .digest('hex')
    .slice(0, 16);
}

// ── OpenAI: Canonical Slug ────────────────────────────────────────────────────

const SYSTEM_PROMPT =
`You are an e-commerce normalization engine. I will give you a messy, \
keyword-stuffed product title. Your job is to strip all SEO filler \
(Kawaii, Y2K, Gift, Cute, Anime, iPhone model numbers, promotional adjectives, \
brand names like MagSafe unless it's the core differentiator) and return a \
strict, slugified 'Canonical Product ID' that represents the core physical item.

Examples:
  "Cute Kawaii Pink Star MagSafe Case for iPhone 14 Gift"
    → pink-star-magsafe-case
  "Sumikko Gurashi MagSafe iPhone 17 16 15 14 13 Pro Max Case with Shaker Grip & Charm, Kawaii Clear Anime Cover"
    → sumikko-gurashi-magsafe-shaker-grip-charm-case
  "Kawaii Sumikko Gurashi MagSafe Case with Shaker Grip & Charm, Cute Anime Character Protection Cover iPhone 17 16 15 14 13 Pro Max Y2K Gift"
    → sumikko-gurashi-magsafe-shaker-grip-charm-case

Rules:
  - Respond ONLY with the slug.
  - Lowercase, hyphens only, no spaces, no punctuation, no quotes.
  - Include the character/IP name (e.g. sumikko-gurashi, cinnamoroll, stitch).
  - Include key physical descriptors (e.g. magsafe, shaker, grip, charm, strap).
  - Omit: phone model numbers, kawaii, cute, y2k, anime, gift, clear, cover, protection, aesthetic.`;

/**
 * Call OpenAI for a single title.  Retries once on transient 429/5xx errors.
 *
 * @param {string} title
 * @param {string} apiKey
 * @param {string} model
 * @returns {Promise<string>} slugified canonical ID
 */
async function fetchCanonicalId(title, apiKey, model) {
  const call = async () => {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: title          },
        ],
        temperature:           0,
        max_completion_tokens: 60,
      }),
    });

    if (resp.status === 429 || resp.status >= 500) {
      const retryAfter = parseInt(resp.headers.get('retry-after') ?? '5', 10);
      await new Promise(r => setTimeout(r, (retryAfter + 1) * 1000));
      throw new Error(`retryable:${resp.status}`);
    }

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`OpenAI ${resp.status}: ${body.slice(0, 400)}`);
    }

    const json    = await resp.json();
    const content = json.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('OpenAI returned empty content');

    // Sanitise to a strict slug regardless of model quirks
    return content
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  };

  try {
    return await call();
  } catch (err) {
    if (err.message.startsWith('retryable:')) {
      // One automatic retry after a rate-limit or transient server error
      return await call();
    }
    throw err;
  }
}

// ── Fallback slug (when API fails) ────────────────────────────────────────────

/**
 * Deterministic best-effort slug from the raw title alone.
 * Used when the API call fails so the row is never lost.
 */
function naiveSlug(title) {
  const STRIP = /\b(kawaii|cute|y2k|anime|iphone|gift|clear|cover|phone|for|with|and|the|a|an|case|aesthetic|protection|magsafe)\b/gi;
  return title
    .replace(STRIP, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 6)
    .join('-') || 'unknown';
}

// ── CSV Serialiser ────────────────────────────────────────────────────────────

function csvField(value) {
  const str = String(value ?? '');
  // Quote fields that contain commas, double-quotes, or line breaks
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replaceAll('"', '""') + '"';
  }
  return str;
}

function serialiseCsv(headers, rows) {
  const headerLine = headers.map(csvField).join(',');
  const dataLines  = rows.map(row => headers.map(h => csvField(row[h] ?? '')).join(','));
  return [headerLine, ...dataLines].join('\r\n') + '\r\n';
}

// ── Phase 1: Ingestion ────────────────────────────────────────────────────────

async function ingest() {
  let files;
  try {
    files = await readdir(RAW_DIR);
  } catch {
    throw new Error(
      `[ingest] Directory not found: ${RAW_DIR}\n` +
      `  → Create the folder and place your EtsyListingsDownload.csv files inside.`,
    );
  }

  const csvFiles = files.filter(f => /\.csv$/i.test(f));
  if (csvFiles.length === 0) {
    throw new Error(`[ingest] No .csv files found in ${RAW_DIR}`);
  }

  console.log(`[ingest] Found ${csvFiles.length} source file(s):`);
  csvFiles.forEach(f => console.log(`         · ${f}`));
  console.log('');

  const allRows = [];

  for (const filename of csvFiles) {
    const shopName = basename(filename, '.csv');
    const filePath = resolve(RAW_DIR, filename);
    let   count    = 0;

    for await (const row of parseCsvFile(filePath)) {
      row.__source_shop = shopName;
      allRows.push(row);
      count++;
    }

    console.log(`[ingest] ${filename}: ${count} rows`);
  }

  console.log(`[ingest] Total ingested: ${allRows.length} rows\n`);
  return allRows;
}

// ── Phase 2: LLM Semantic Normalisation ──────────────────────────────────────

async function normalise(rows) {
  const cache   = await loadCache();
  const limit   = createLimiter(CONCURRENCY);
  const total   = rows.length;

  let cacheHits    = 0;
  let apiCalls     = 0;
  let errors       = 0;
  let cacheUpdated = false;

  console.log(`[normalize] ${total} rows — concurrency: ${CONCURRENCY}, model: ${OPENAI_MODEL}`);

  // De-duplicate titles so we only call the API once per unique title,
  // then fan the result back out to every row sharing that title.
  const titleToRows = new Map();
  for (const row of rows) {
    const t = row.TITLE?.trim() ?? '';
    if (!titleToRows.has(t)) titleToRows.set(t, []);
    titleToRows.get(t).push(row);
  }

  const uniqueTitles = [...titleToRows.keys()];
  console.log(`[normalize] ${uniqueTitles.length} unique titles (${total - uniqueTitles.length} will reuse cached/first result)\n`);

  let done = 0;

  const tasks = uniqueTitles.map(title => limit(async () => {
    done++;
    const progress = `[${done}/${uniqueTitles.length}]`;

    // Empty title guard
    if (!title) {
      for (const r of titleToRows.get(title)) r.__canonical_id = 'unknown';
      return;
    }

    const key = titleKey(title);

    // Serve from cache
    if (cache.entries[key]) {
      const slug = cache.entries[key].canonical_id;
      for (const r of titleToRows.get(title)) r.__canonical_id = slug;
      cacheHits++;
      console.log(`[normalize] ${progress} CACHE "${title.slice(0, 55)}" → "${slug}"`);
      return;
    }

    // Call OpenAI
    let slug;
    try {
      slug = await fetchCanonicalId(title, OPENAI_KEY, OPENAI_MODEL);
      apiCalls++;
      console.log(`[normalize] ${progress} API   "${title.slice(0, 55)}" → "${slug}"`);
    } catch (err) {
      errors++;
      slug = naiveSlug(title);
      console.error(`[normalize] ${progress} ERROR "${title.slice(0, 55)}" — ${err.message} (fallback: "${slug}")`);
    }

    for (const r of titleToRows.get(title)) r.__canonical_id = slug;

    cache.entries[key] = {
      canonical_id: slug,
      title,
      model:        OPENAI_MODEL,
      timestamp:    new Date().toISOString(),
    };
    cacheUpdated = true;
  }));

  await Promise.all(tasks);

  if (cacheUpdated) {
    await saveCache(cache);
    console.log(`\n[normalize] Cache updated → ${CACHE_PATH}`);
  }

  console.log(
    `[normalize] Done — ` +
    `${cacheHits} cache hits · ${apiCalls} API calls · ${errors} errors\n`,
  );
}

// ── Phase 3: Grouping & Survivorship Rules ────────────────────────────────────

/**
 * Merge a group of duplicate rows into a single Golden Record.
 *
 * Survivorship rules:
 *   TITLE    — shortest string (least SEO-stuffed)
 *   QUANTITY — sum of all rows
 *   TAGS     — union of all unique tags (comma-joined)
 *   IMAGE*   — deduplicated union packed into IMAGE1…IMAGE10
 *   all else — inherited from the title-winner row
 */
function applysurvivorship(group) {
  if (group.length === 1) return { ...group[0] };

  // Winner = shortest title
  const winner = group.reduce((a, b) =>
    (a.TITLE?.length ?? Infinity) <= (b.TITLE?.length ?? Infinity) ? a : b,
  );

  const golden = { ...winner };

  // QUANTITY: sum
  golden.QUANTITY = String(
    group.reduce((sum, r) => sum + (parseInt(r.QUANTITY, 10) || 0), 0),
  );

  // TAGS: union
  const tagSet = new Set(
    group.flatMap(r =>
      (r.TAGS ?? '').split(',').map(t => t.trim()).filter(Boolean),
    ),
  );
  golden.TAGS = [...tagSet].join(', ');

  // IMAGES: deduplicated union → IMAGE1…IMAGE10
  const imageSet = [...new Set(
    group.flatMap(r => IMAGE_KEYS.map(k => r[k]).filter(Boolean)),
  )];
  IMAGE_KEYS.forEach((k, i) => { golden[k] = imageSet[i] ?? ''; });

  return golden;
}

function groupAndMerge(rows) {
  const groups = new Map();

  for (const row of rows) {
    const key = row.__canonical_id ?? 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const goldenRecords = [];
  let   mergedCount   = 0;

  for (const [key, group] of groups) {
    if (group.length > 1) {
      mergedCount += group.length - 1;
      const shops = [...new Set(group.map(r => r.__source_shop))].join(', ');
      console.log(
        `[merge] "${key}" — ${group.length} variants → 1 golden record` +
        ` (shops: ${shops})`,
      );
    }
    goldenRecords.push(applysurvivorship(group));
  }

  console.log('');
  return { goldenRecords, mergedCount, groupCount: groups.size };
}

// ── Phase 4: Egress ───────────────────────────────────────────────────────────

async function egress(records) {
  // Strip internal __ fields before writing
  const clean = records.map(r => {
    const out = Object.create(null);
    for (const h of ETSY_HEADERS) out[h] = r[h] ?? '';
    return out;
  });

  const csv = serialiseCsv(ETSY_HEADERS, clean);
  await mkdir(dirname(OUTPUT_CSV), { recursive: true });
  await writeFile(OUTPUT_CSV, csv, 'utf-8');
  console.log(`[egress] Written → ${OUTPUT_CSV}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!OPENAI_KEY) {
    throw new Error(
      'OPENAI_API_KEY is not configured.\n' +
      '  Add it to your .env file: OPENAI_API_KEY=sk-...',
    );
  }

  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   Y2KASE Semantic Deduplication Pipeline  ✦      ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  Model:        ${OPENAI_MODEL}`);
  console.log(`  Concurrency:  ${CONCURRENCY}`);
  console.log(`  Source:       ${RAW_DIR}`);
  console.log(`  Output:       ${OUTPUT_CSV}`);
  console.log('');

  const startMs = Date.now();

  // Phase 1
  const rows = await ingest();

  // Phase 2
  await normalise(rows);

  // Phase 3
  const { goldenRecords, mergedCount, groupCount } = groupAndMerge(rows);

  // Phase 4
  await egress(goldenRecords);

  const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);

  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║                    Summary                        ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  Processed   ${rows.length} rows`);
  console.log(`  Found       ${groupCount} unique canonical products`);
  console.log(`  Merged      ${mergedCount} duplicate listings`);
  console.log(`  Elapsed     ${elapsedSec}s`);
  console.log(`  Output      ${OUTPUT_CSV}`);
  console.log('');
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});
