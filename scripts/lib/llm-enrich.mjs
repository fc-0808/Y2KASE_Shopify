/**
 * LLM-powered style extraction for Etsy product descriptions.
 *
 * This is the SOLE source of truth for which bundle/variation styles each
 * product offers.  There is no regex fallback — gpt-5.4-mini reads the
 * description and returns a structured list of style names for every product,
 * regardless of which Etsy shop the CSV came from or how the seller wrote
 * their description.
 *
 * ── Architecture ─────────────────────────────────────────────────────────────
 *
 *   For every product:
 *
 *   ┌─────────────────────────────┐
 *   │  Check disk cache           │  SHA-256(description) → cached styles?
 *   │  .cache/style-enrichments   │──── HIT ──▶  return cached (free, instant)
 *   └──────────────┬──────────────┘
 *                  │ MISS
 *                  ▼
 *   ┌─────────────────────────────┐
 *   │  gpt-5.4-mini               │  Batched, temp=0, structured JSON output
 *   │  Structured JSON schema     │  (enum-constrained — no hallucinated names)
 *   └──────────────┬──────────────┘
 *                  │
 *                  ▼
 *   ┌─────────────────────────────┐
 *   │  Write to disk cache        │  Persisted by description hash
 *   └──────────────┬──────────────┘
 *                  │
 *                  ▼
 *   ┌─────────────────────────────┐
 *   │  inferMissingBundleStyles() │  Business logic: Case+Grip → Grip Only, etc.
 *   └──────────────┬──────────────┘
 *                  │
 *                  ▼
 *             return result
 *
 * ── Why structured output (json_schema with enum) ────────────────────────────
 *   The JSON schema constrains the model's output to VALID_STYLES enum values.
 *   The OpenAI API rejects any non-enum value at the protocol level — the model
 *   is physically incapable of hallucinating a style name that does not exist
 *   in our SKU / price tables.
 *
 * ── Why a disk cache ─────────────────────────────────────────────────────────
 *   Keyed by SHA-256(description).  Once a description has been processed,
 *   every subsequent server start reads from disk — zero API calls, zero cost.
 *   Delete .cache/style-enrichments.json to force a full re-run.
 *
 * ── Why temperature=0 ────────────────────────────────────────────────────────
 *   Fully deterministic.  Same description always produces the same output.
 *   Combined with the cache this means enrichment is reproducible across runs.
 */

import { createHash }                  from 'node:crypto';
import { readFile, writeFile, mkdir }  from 'node:fs/promises';
import { resolve, dirname }            from 'node:path';
import { fileURLToPath }               from 'node:url';
import { inferMissingBundleStyles }    from './normalize.mjs';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = resolve(__dirname, '../../.cache/style-enrichments.json');
const CACHE_DIR  = resolve(__dirname, '../../.cache');

// ── Valid style universe ───────────────────────────────────────────────────────
// Injected into the JSON schema as an enum so the model cannot produce a style
// name that doesn't exist in STYLE_PRICES / STYLE_SKU_CODE in transform.mjs.

export const VALID_STYLES = [
  'Case+Grip+Charm',
  'Case+Grip',
  'Case+Charm',
  'Case Only',
  'Grip Only',
  'Charm Only',
  'Case+Strap',
  'Strap Only',
];

// ── Cache helpers ──────────────────────────────────────────────────────────────

/** @returns {string} First 16 hex chars of SHA-256(text) */
function descHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

async function loadCache() {
  try {
    return JSON.parse(await readFile(CACHE_PATH, 'utf-8'));
  } catch {
    return { version: 1, entries: {} };
  }
}

async function saveCache(cache) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
}

// ── OpenAI call ───────────────────────────────────────────────────────────────

/**
 * Send up to 10 products in one API request.
 * Returns { [descHash]: string[] } — raw extracted styles before inference.
 *
 * @param {Array<{hash:string, title:string, description:string}>} batch
 * @param {string} apiKey
 * @param {string} model
 */
async function callLLM(batch, apiKey, model) {
  const productList = batch
    .map((p, i) =>
      `[id: ${p.hash}]\n` +
      `Title: ${p.title}\n` +
      `Description:\n${p.description.slice(0, 2000)}`
    )
    .join('\n\n---\n\n');

  const systemPrompt =
`You are an e-commerce data extraction assistant for an ETL pipeline that migrates Etsy listings to Shopify.

YOUR TASK:
For each product below, identify which bundle/variation style options the seller is offering, based on their product description.

VALID STYLE NAMES — return ONLY strings from this exact list:
${VALID_STYLES.map(s => `  • "${s}"`).join('\n')}

HOW TO IDENTIFY STYLES:
Sellers describe their bundle options in a dedicated breakdown section. Look for lines that explicitly label each purchasable option. Common patterns (case-insensitive, varied punctuation):

  "The Full Set: (Case + Grip + Charm...)"  → "Case+Grip+Charm"
  "The Full Set: (Case + Grip...)"          → "Case+Grip"   (no charm mentioned)
  "Case + Grip + Charm: ..."                → "Case+Grip+Charm"
  "Case + Grip: ..."                        → "Case+Grip"
  "Case + Charm: ..."                       → "Case+Charm"
  "Case Only: ..."  or  "Case Only" alone   → "Case Only"
  "Grip Only: ..."  or  "Grip Only" alone   → "Grip Only"
  "Charm Only: ..." or  "Charm Only" alone  → "Charm Only"
  "Case + Strap: ..."                       → "Case+Strap"
  "Strap Only: ..."  or "Strap Only" alone  → "Strap Only"

RULES:
  • Return every style the seller explicitly lists — do not add extras, do not drop any.
  • Return an empty array [] only if there is no bundle breakdown section at all.
  • Do NOT infer — just extract what is written. (Inference is handled downstream.)
  • Output: JSON object where each key is the product [id] hash and the value is an array.`;

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: productList  },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name:   'style_extraction',
          strict: true,
          schema: {
            type:                 'object',
            additionalProperties: {
              type:  'array',
              items: { type: 'string', enum: VALID_STYLES },
            },
          },
        },
      },
      temperature: 0,
      max_tokens:  800,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OpenAI ${resp.status}: ${body.slice(0, 400)}`);
  }

  const json    = await resp.json();
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned empty content');

  return JSON.parse(content);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Enrich ALL products with LLM-extracted styles.
 *
 * Products whose description text has already been processed are served from
 * the disk cache instantly.  Only genuine cache misses trigger API calls.
 *
 * After extraction, inferMissingBundleStyles() applies business-logic
 * completeness rules (Case+Grip → Grip Only, Case+Charm → Charm Only) and
 * sorts to canonical Shopify variant order.
 *
 * @param {import('./normalize.mjs').EtsyProduct[]} products
 * @param {string}  apiKey   process.env.OPENAI_API_KEY
 * @param {string}  [model]  defaults to 'gpt-5.4-mini'
 * @returns {Promise<Map<string, {stylesFromDescription:string[], stylesInferred:string[]}>>}
 *   Keyed by product title.  Every product with a non-empty description appears
 *   in the map.
 */
export async function enrichProductStyles(products, apiKey, model = 'gpt-5.4-mini') {
  if (!apiKey) {
    console.warn('[llm-enrich] OPENAI_API_KEY not set — style extraction skipped');
    return new Map();
  }

  const eligible = products.filter(p => p.description?.trim());

  if (!eligible.length) {
    console.info('[llm-enrich] No products with descriptions found');
    return new Map();
  }

  const cache     = await loadCache();
  const toCall    = [];
  const resultMap = new Map();

  // ── Serve from cache where possible ─────────────────────────────────────────
  for (const p of eligible) {
    const hash = descHash(p.description);
    if (cache.entries[hash]) {
      const { styles, inferred } = inferMissingBundleStyles(cache.entries[hash].styles);
      resultMap.set(p.title, { stylesFromDescription: styles, stylesInferred: inferred });
    } else {
      toCall.push({ hash, title: p.title, description: p.description });
    }
  }

  const cacheHits = eligible.length - toCall.length;
  console.info(
    `[llm-enrich] ${eligible.length} products — ` +
    `${cacheHits} cache hits, ${toCall.length} need ${model}`,
  );

  if (!toCall.length) return resultMap;

  // ── Call the LLM in batches of 10 ────────────────────────────────────────────
  const LLM_BATCH  = 10;
  let cacheUpdated = false;

  for (let i = 0; i < toCall.length; i += LLM_BATCH) {
    const batch     = toCall.slice(i, i + LLM_BATCH);
    const batchNum  = Math.floor(i / LLM_BATCH) + 1;
    const batchTotal = Math.ceil(toCall.length / LLM_BATCH);

    console.info(
      `[llm-enrich] Calling ${model} — batch ${batchNum}/${batchTotal}` +
      ` (${batch.length} products)…`,
    );

    let llmResult;
    try {
      llmResult = await callLLM(batch, apiKey, model);
    } catch (err) {
      // Non-fatal: these products fall through to resolveVariations() fallbacks.
      console.error(`[llm-enrich] Batch ${batchNum} failed: ${err.message}`);
      continue;
    }

    for (const item of batch) {
      // Defensive filter in case the model slipped past the schema
      const rawStyles = (llmResult[item.hash] ?? []).filter(s => VALID_STYLES.includes(s));

      // Persist raw LLM output (pre-inference) so re-runs can reproduce the
      // inferred set even after inference rule changes.
      cache.entries[item.hash] = {
        styles:    rawStyles,
        model,
        title:     item.title,
        timestamp: new Date().toISOString(),
      };
      cacheUpdated = true;

      const { styles, inferred } = inferMissingBundleStyles(rawStyles);
      resultMap.set(item.title, { stylesFromDescription: styles, stylesInferred: inferred });

      const inferBadge = inferred.length ? `  (+inferred: ${inferred.join(', ')})` : '';
      console.info(
        `[llm-enrich]  ✓ "${item.title.slice(0, 52)}"` +
        `  →  [${styles.join(', ')}]${inferBadge}`,
      );
    }
  }

  if (cacheUpdated) {
    await saveCache(cache);
    console.info(`[llm-enrich] Cache saved → ${CACHE_PATH}`);
  }

  return resultMap;
}
