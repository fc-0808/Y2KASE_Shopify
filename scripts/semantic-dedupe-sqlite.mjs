/**
 * Y2KASE MDM Deduplication Pipeline — SQLite Edition
 *
 * Upgrades the flat-file JSON cache to a persistent, queryable SQLite
 * Master Data Management system at data/mdm_catalog.db.
 *
 * ── Three Persistent Tables ───────────────────────────────────────────────────
 *
 *   canonical_cache   LLM slug lookups — NEVER cleared between runs.
 *                     The permanent de-duplication investment; re-runs cost $0
 *                     for any title already resolved.
 *
 *   raw_listings      Full ingested rows with shop lineage — rebuilt each run.
 *                     Full audit trail of every source row.
 *
 *   golden_records    SQL-aggregated merged products — rebuilt each run.
 *                     The single source of truth consumed by egress.
 *
 * ── Pipeline Phases ───────────────────────────────────────────────────────────
 *
 *   1. DB Init        — Open / create mdm_catalog.db, run DDL, clear working
 *                       tables (raw_listings, golden_records).
 *
 *   2. Ingest & Store — Stream CSVs from data/raw_sources/, tag each row with
 *                       __source_shop, de-duplicate titles, resolve canonical
 *                       slugs (SQLite cache → OpenAI fallback), INSERT rows
 *                       into raw_listings inside a single WAL transaction.
 *
 *   3. SQL Survivorship — GROUP BY canonical_slug to aggregate:
 *                         • SUM(quantity), MAX(price) — pure SQL
 *                         • Shortest title            — subquery per group
 *                         • Merged tags & images      — JS Set deduplication
 *                         UPSERT results into golden_records.
 *
 *   4. Egress         — SELECT * FROM golden_records, map to Etsy column order,
 *                       write data/EtsyListingsDownload_Golden.csv.
 *
 * Usage:
 *   node scripts/semantic-dedupe-sqlite.mjs
 *   node scripts/semantic-dedupe-sqlite.mjs --concurrency 10
 *   node scripts/semantic-dedupe-sqlite.mjs --reset-cache    (nuke LLM cache)
 */

import { createHash }              from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath }            from 'node:url';
import Database                     from 'better-sqlite3';
import { parseCsvFile }             from './lib/csv-parser.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Environment ───────────────────────────────────────────────────────────────

function loadEnv(filePath) {
  if (!existsSync(filePath)) return;
  let text = readFileSync(filePath, 'utf-8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
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

const concurrencyArg = process.argv.indexOf('--concurrency');
const CONCURRENCY    = concurrencyArg !== -1
  ? Math.max(1, parseInt(process.argv[concurrencyArg + 1], 10) || 8)
  : 8;

const RESET_CACHE = process.argv.includes('--reset-cache');

// ── Paths ─────────────────────────────────────────────────────────────────────

const RAW_DIR    = resolve(__dirname, '../data/raw_sources');
const OUTPUT_CSV = resolve(__dirname, '../data/EtsyListingsDownload_Golden.csv');
const DB_PATH    = resolve(__dirname, '../data/mdm_catalog.db');

// Exact Etsy export column order — egress must match this precisely.
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

const IMAGE_KEYS = [
  'IMAGE1', 'IMAGE2', 'IMAGE3', 'IMAGE4', 'IMAGE5',
  'IMAGE6', 'IMAGE7', 'IMAGE8', 'IMAGE9', 'IMAGE10',
];

// ASCII Record Separator (char 30) — safe GROUP_CONCAT delimiter;
// never appears in product titles, tags, or image URLs.
const RS = '\x1E';

// ── Concurrency Limiter ───────────────────────────────────────────────────────
// Minimal p-limit equivalent — zero external dependencies.

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

// ── Title Fingerprint ─────────────────────────────────────────────────────────

/** 16-char hex digest keyed on the lowercased, trimmed title. */
function titleHash(title) {
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
 * Call OpenAI for a single title. Retries once on 429/5xx.
 *
 * @param {string} title
 * @returns {Promise<string>} Slugified canonical ID
 */
async function fetchCanonicalId(title) {
  const call = async () => {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: title          },
        ],
        temperature:           0,
        max_completion_tokens: 60,
      }),
    });

    if (resp.status === 429 || resp.status >= 500) {
      const wait = (parseInt(resp.headers.get('retry-after') ?? '5', 10) + 1) * 1000;
      await new Promise(r => setTimeout(r, wait));
      throw new Error(`retryable:${resp.status}`);
    }

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`OpenAI ${resp.status}: ${body.slice(0, 400)}`);
    }

    const json    = await resp.json();
    const content = json.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('OpenAI returned empty content');

    return content
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  };

  try {
    return await call();
  } catch (err) {
    if (err.message.startsWith('retryable:')) return await call();
    throw err;
  }
}

// ── Fallback Slug ─────────────────────────────────────────────────────────────

/** Deterministic best-effort slug used when the API call fails. */
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

// ── Phase 1: Database Initialization ─────────────────────────────────────────

/**
 * Open (or create) mdm_catalog.db, apply DDL, return db + prepared statements.
 * canonical_cache is persistent across runs.
 * raw_listings and golden_records are rebuilt fresh on every run.
 */
function initDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  if (RESET_CACHE) {
    db.exec('DROP TABLE IF EXISTS canonical_cache;');
    console.log('[db] --reset-cache: canonical_cache dropped and will be rebuilt\n');
  }

  // canonical_cache: persistent LLM slug store, never dropped
  db.exec(`
    CREATE TABLE IF NOT EXISTS canonical_cache (
      title_hash     TEXT PRIMARY KEY,
      raw_title      TEXT NOT NULL,
      canonical_slug TEXT NOT NULL,
      model          TEXT NOT NULL,
      created_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cc_slug ON canonical_cache(canonical_slug);
  `);

  // raw_listings + golden_records: rebuilt on every run for a clean slate
  db.exec(`
    DROP TABLE IF EXISTS golden_records;
    DROP TABLE IF EXISTS raw_listings;

    CREATE TABLE raw_listings (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      source_shop     TEXT    NOT NULL,
      raw_title       TEXT    NOT NULL,
      canonical_slug  TEXT    NOT NULL,
      quantity        INTEGER NOT NULL DEFAULT 0,
      price           REAL    NOT NULL DEFAULT 0,
      tags            TEXT,
      image_urls      TEXT,
      description     TEXT,
      materials       TEXT,
      currency_code   TEXT,
      variation1_type TEXT,
      variation1_name TEXT,
      variation1_vals TEXT,
      variation2_type TEXT,
      variation2_name TEXT,
      variation2_vals TEXT,
      sku             TEXT,
      ingested_at     TEXT    NOT NULL
    );
    CREATE INDEX idx_rl_slug ON raw_listings(canonical_slug);

    CREATE TABLE golden_records (
      canonical_slug  TEXT    PRIMARY KEY,
      merged_title    TEXT    NOT NULL,
      total_quantity  INTEGER NOT NULL DEFAULT 0,
      highest_price   REAL    NOT NULL DEFAULT 0,
      merged_tags     TEXT,
      merged_images   TEXT,
      description     TEXT,
      materials       TEXT,
      currency_code   TEXT,
      variation1_type TEXT,
      variation1_name TEXT,
      variation1_vals TEXT,
      variation2_type TEXT,
      variation2_name TEXT,
      variation2_vals TEXT,
      sku             TEXT,
      source_shops    TEXT,
      row_count       INTEGER NOT NULL DEFAULT 1,
      updated_at      TEXT    NOT NULL
    );
  `);

  // Prepared statements — compiled once, reused for every row
  const stmts = {
    getCached: db.prepare(
      'SELECT canonical_slug FROM canonical_cache WHERE title_hash = ?',
    ),

    insertCache: db.prepare(`
      INSERT OR REPLACE INTO canonical_cache
        (title_hash, raw_title, canonical_slug, model, created_at)
      VALUES (?, ?, ?, ?, ?)
    `),

    insertRaw: db.prepare(`
      INSERT INTO raw_listings (
        source_shop, raw_title, canonical_slug,
        quantity, price, tags, image_urls,
        description, materials, currency_code,
        variation1_type, variation1_name, variation1_vals,
        variation2_type, variation2_name, variation2_vals,
        sku, ingested_at
      ) VALUES (
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?
      )
    `),

    // SQL aggregation: SUM quantity, MAX price, concat tags + images for JS dedup
    getGrouped: db.prepare(`
      SELECT
        canonical_slug,
        SUM(quantity)                       AS total_quantity,
        MAX(price)                          AS highest_price,
        GROUP_CONCAT(DISTINCT source_shop)  AS source_shops,
        COUNT(*)                            AS row_count,
        GROUP_CONCAT(tags,       char(30))  AS all_tags,
        GROUP_CONCAT(image_urls, char(30))  AS all_images_json
      FROM raw_listings
      GROUP BY canonical_slug
      ORDER BY canonical_slug
    `),

    // Subquery: pick the row with the shortest title for representative fields
    getShortestRow: db.prepare(`
      SELECT
        raw_title, description, materials, currency_code,
        variation1_type, variation1_name, variation1_vals,
        variation2_type, variation2_name, variation2_vals,
        sku
      FROM raw_listings
      WHERE canonical_slug = ?
      ORDER BY LENGTH(raw_title) ASC
      LIMIT 1
    `),

    upsertGolden: db.prepare(`
      INSERT OR REPLACE INTO golden_records (
        canonical_slug, merged_title,
        total_quantity, highest_price,
        merged_tags, merged_images,
        description, materials, currency_code,
        variation1_type, variation1_name, variation1_vals,
        variation2_type, variation2_name, variation2_vals,
        sku, source_shops, row_count, updated_at
      ) VALUES (
        ?, ?,
        ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?
      )
    `),

    getAllGolden: db.prepare('SELECT * FROM golden_records ORDER BY canonical_slug'),

    countGolden:  db.prepare('SELECT COUNT(*) AS n FROM golden_records'),
    countRaw:     db.prepare('SELECT COUNT(*) AS n FROM raw_listings'),
    countCache:   db.prepare('SELECT COUNT(*) AS n FROM canonical_cache'),
  };

  return { db, stmts };
}

// ── Phase 2: Ingestion & LLM Processing ──────────────────────────────────────

async function ingestAndNormalise(db, stmts) {
  // ── 2a. Read source CSVs ─────────────────────────────────────────────────────
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

  // ── 2b. De-duplicate titles for API efficiency ───────────────────────────────
  // Group rows by normalised title so each unique title hits the API once.
  const titleToRows = new Map();
  for (const row of allRows) {
    const t = row.TITLE?.trim() ?? '';
    if (!titleToRows.has(t)) titleToRows.set(t, []);
    titleToRows.get(t).push(row);
  }

  const uniqueTitles = [...titleToRows.keys()];
  const reused       = allRows.length - uniqueTitles.length;

  console.log(
    `[normalize] ${uniqueTitles.length} unique titles` +
    (reused > 0 ? ` (${reused} rows will inherit resolved slug)` : '') +
    `\n[normalize] Concurrency: ${CONCURRENCY}  Model: ${OPENAI_MODEL}\n`,
  );

  // ── 2c. Resolve canonical slugs (SQLite cache → OpenAI fallback) ─────────────
  const limit = createLimiter(CONCURRENCY);
  let cacheHits = 0;
  let apiCalls  = 0;
  let errors    = 0;
  let done      = 0;

  const tasks = uniqueTitles.map(title => limit(async () => {
    done++;
    const progress = `[${done}/${uniqueTitles.length}]`;

    if (!title) {
      for (const r of titleToRows.get(title)) r.__canonical_id = 'unknown';
      return;
    }

    const hash = titleHash(title);

    // SQLite cache lookup (synchronous — no event-loop contention)
    const cached = stmts.getCached.get(hash);
    if (cached) {
      for (const r of titleToRows.get(title)) r.__canonical_id = cached.canonical_slug;
      cacheHits++;
      console.log(`[normalize] ${progress} CACHE "${title.slice(0, 55)}" → "${cached.canonical_slug}"`);
      return;
    }

    // Cache miss — call OpenAI
    let slug;
    try {
      slug = await fetchCanonicalId(title);
      apiCalls++;
      console.log(`[normalize] ${progress} API   "${title.slice(0, 55)}" → "${slug}"`);
    } catch (err) {
      errors++;
      slug = naiveSlug(title);
      console.error(
        `[normalize] ${progress} ERROR "${title.slice(0, 55)}"` +
        ` — ${err.message} (fallback: "${slug}")`,
      );
    }

    for (const r of titleToRows.get(title)) r.__canonical_id = slug;

    // Persist to SQLite canonical cache
    stmts.insertCache.run(hash, title, slug, OPENAI_MODEL, new Date().toISOString());
  }));

  await Promise.all(tasks);

  console.log(
    `\n[normalize] Done — ` +
    `${cacheHits} cache hits · ${apiCalls} API calls · ${errors} errors\n`,
  );

  // ── 2d. INSERT all rows into raw_listings (single WAL transaction) ────────────
  console.log(`[store] Writing ${allRows.length} rows to raw_listings…`);

  const insertMany = db.transaction((rows) => {
    const now = new Date().toISOString();
    for (const row of rows) {
      const images = IMAGE_KEYS.map(k => row[k]).filter(Boolean);
      stmts.insertRaw.run(
        row.__source_shop,
        row.TITLE?.trim() ?? '',
        row.__canonical_id ?? 'unknown',
        parseInt(row.QUANTITY, 10)  || 0,
        parseFloat(row.PRICE)       || 0,
        row.TAGS      ?? null,
        JSON.stringify(images),
        row.DESCRIPTION                ?? null,
        row.MATERIALS                  ?? null,
        row.CURRENCY_CODE              ?? null,
        row['VARIATION 1 TYPE']        ?? null,
        row['VARIATION 1 NAME']        ?? null,
        row['VARIATION 1 VALUES']      ?? null,
        row['VARIATION 2 TYPE']        ?? null,
        row['VARIATION 2 NAME']        ?? null,
        row['VARIATION 2 VALUES']      ?? null,
        row.SKU        ?? null,
        now,
      );
    }
  });

  insertMany(allRows);
  console.log(`[store] Committed ${allRows.length} rows → raw_listings\n`);

  return allRows.length;
}

// ── Phase 3: SQL-Native Survivorship ─────────────────────────────────────────

function buildGoldenRecords(stmts) {
  const groups     = stmts.getGrouped.all();
  const now        = new Date().toISOString();
  let   merged     = 0;
  let   singletons = 0;

  console.log(`[merge] Processing ${groups.length} canonical product group(s)…\n`);

  const upsertAll = stmts.upsertGolden.database.transaction(() => {
    for (const group of groups) {
      // Representative row: the shortest title carries non-aggregated fields
      const winner = stmts.getShortestRow.get(group.canonical_slug);

      if (!winner) continue; // should never happen

      // Tags — split each row's tag string, union + deduplicate
      const mergedTags = [
        ...new Set(
          (group.all_tags ?? '')
            .split(RS)
            .flatMap(t => t.split(',').map(s => s.trim()))
            .filter(Boolean),
        ),
      ].join(', ');

      // Images — each raw_listings.image_urls is a JSON array; union + dedup
      const mergedImages = [
        ...new Set(
          (group.all_images_json ?? '')
            .split(RS)
            .flatMap(j => {
              try { return JSON.parse(j); }
              catch { return []; }
            })
            .filter(Boolean),
        ),
      ].slice(0, 10); // Etsy supports IMAGE1–IMAGE10

      // Source shops — de-duplicate the GROUP_CONCAT result
      const sourceShops = [
        ...new Set((group.source_shops ?? '').split(',').map(s => s.trim())),
      ].join(', ');

      const isMulti = group.row_count > 1;
      if (isMulti) {
        merged++;
        console.log(
          `[merge] "${group.canonical_slug}" — ` +
          `${group.row_count} listings → 1 golden record` +
          ` (qty: ${group.total_quantity}, shops: ${sourceShops})`,
        );
      } else {
        singletons++;
      }

      stmts.upsertGolden.run(
        group.canonical_slug,
        winner.raw_title,
        group.total_quantity,
        group.highest_price,
        mergedTags                   || null,
        JSON.stringify(mergedImages),
        winner.description           || null,
        winner.materials             || null,
        winner.currency_code         || null,
        winner.variation1_type       || null,
        winner.variation1_name       || null,
        winner.variation1_vals       || null,
        winner.variation2_type       || null,
        winner.variation2_name       || null,
        winner.variation2_vals       || null,
        winner.sku                   || null,
        sourceShops                  || null,
        group.row_count,
        now,
      );
    }
  });

  upsertAll();

  const totalMergedRows = groups
    .filter(g => g.row_count > 1)
    .reduce((sum, g) => sum + (g.row_count - 1), 0);

  console.log('');
  return {
    groupCount:    groups.length,
    mergedGroups:  merged,
    singletons,
    mergedRowsSaved: totalMergedRows,
  };
}

// ── Phase 4: Egress ───────────────────────────────────────────────────────────

async function egress(stmts) {
  const goldenRows = stmts.getAllGolden.all();

  // Map each golden_record to the flat Etsy column structure
  const etsyRows = goldenRows.map(gr => {
    const images = (() => {
      try { return JSON.parse(gr.merged_images ?? '[]'); }
      catch { return []; }
    })();

    const out = Object.create(null);

    out['TITLE']             = gr.merged_title     ?? '';
    out['DESCRIPTION']       = gr.description      ?? '';
    out['PRICE']             = gr.highest_price     ?? '';
    out['CURRENCY_CODE']     = gr.currency_code     ?? '';
    out['QUANTITY']          = gr.total_quantity    ?? 0;
    out['TAGS']              = gr.merged_tags       ?? '';
    out['MATERIALS']         = gr.materials         ?? '';

    IMAGE_KEYS.forEach((key, i) => { out[key] = images[i] ?? ''; });

    out['VARIATION 1 TYPE']   = gr.variation1_type ?? '';
    out['VARIATION 1 NAME']   = gr.variation1_name ?? '';
    out['VARIATION 1 VALUES'] = gr.variation1_vals ?? '';
    out['VARIATION 2 TYPE']   = gr.variation2_type ?? '';
    out['VARIATION 2 NAME']   = gr.variation2_name ?? '';
    out['VARIATION 2 VALUES'] = gr.variation2_vals ?? '';
    out['SKU']                = gr.sku              ?? '';

    return out;
  });

  const csv = serialiseCsv(ETSY_HEADERS, etsyRows);
  await mkdir(dirname(OUTPUT_CSV), { recursive: true });
  await writeFile(OUTPUT_CSV, csv, 'utf-8');

  console.log(`[egress] Written ${goldenRows.length} golden records → ${OUTPUT_CSV}`);
  return goldenRows.length;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!OPENAI_KEY) {
    throw new Error(
      'OPENAI_API_KEY is not configured.\n' +
      '  Add OPENAI_API_KEY=sk-... to your .env file.',
    );
  }

  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Y2KASE MDM Deduplication — SQLite Edition  ✦   ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  Model:        ${OPENAI_MODEL}`);
  console.log(`  Concurrency:  ${CONCURRENCY}`);
  console.log(`  Database:     ${DB_PATH}`);
  console.log(`  Source:       ${RAW_DIR}`);
  console.log(`  Output:       ${OUTPUT_CSV}`);
  if (RESET_CACHE) console.log('  Mode:         --reset-cache (LLM cache will be rebuilt)');
  console.log('');

  const startMs = Date.now();

  // Phase 1: DB Init
  await mkdir(dirname(DB_PATH), { recursive: true });
  const { db, stmts } = initDb();
  console.log(`[db] Connected → ${DB_PATH}\n`);

  try {
    // Phase 2: Ingest CSVs + resolve slugs + store raw_listings
    const totalRows = await ingestAndNormalise(db, stmts);

    // Phase 3: SQL aggregation + JS deduplication → golden_records
    const { groupCount, mergedGroups, singletons, mergedRowsSaved } =
      buildGoldenRecords(stmts);

    // Phase 4: golden_records → EtsyListingsDownload_Golden.csv
    await egress(stmts);

    const elapsedSec  = ((Date.now() - startMs) / 1000).toFixed(1);
    const cacheTotal  = stmts.countCache.get().n;

    console.log('');
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║                    Summary  ✦                    ║');
    console.log('╚══════════════════════════════════════════════════╝');
    console.log(`  Processed        ${totalRows} raw rows`);
    console.log(`  Unique products  ${groupCount}`);
    console.log(`    ↳ Merged groups  ${mergedGroups}  (${mergedRowsSaved} duplicate rows collapsed)`);
    console.log(`    ↳ Singletons     ${singletons}`);
    console.log(`  Canonical cache  ${cacheTotal} entries (data/mdm_catalog.db)`);
    console.log(`  Elapsed          ${elapsedSec}s`);
    console.log(`  Output           ${OUTPUT_CSV}`);
    console.log('');
  } finally {
    db.close();
  }
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});
