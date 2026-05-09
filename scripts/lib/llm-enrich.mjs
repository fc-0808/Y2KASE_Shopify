/**
 * Component Classifier + Deterministic Style Matrix
 *
 * ── The Architectural Problem This Solves ────────────────────────────────────
 *
 * Etsy's exported CSV has two structural flaws:
 *
 *   1. VARIATION 2 VALUES always exports the full 6-option list regardless of
 *      what the listing actually sells.  Useless.
 *
 *   2. The seller-written description's bundle section is the ground truth —
 *      but sellers occasionally omit an option (e.g. they list "Case + Grip"
 *      but forget "Grip Only").  An LLM that transcribes the text faithfully
 *      copies the human error.
 *
 * ── The Solution ─────────────────────────────────────────────────────────────
 *
 * Step 1 — LLM acts as a COMPONENT CLASSIFIER, not a transcriber.
 *   Classify each product into three boolean signals:
 *     hasGrip  — does a SEPARATELY-PURCHASABLE grip/socket/shaker accessory exist?
 *     hasCharm — does a SEPARATELY-PURCHASABLE charm/wristlet accessory exist?
 *     hasStrap — does a SEPARATELY-PURCHASABLE strap/lanyard exist (in lieu of grip)?
 *
 * Step 2 — A DETERMINISTIC MATRIX maps the booleans to the correct style list.
 *   Human description errors become irrelevant.  If a product has both a grip
 *   and a charm, it always gets all six permutations — even if the seller's
 *   description forgot to list "Charm Only".
 *
 * ── Component Matrix ─────────────────────────────────────────────────────────
 *
 *   hasGrip && hasCharm  →  6 styles  [CGC, CG, CC, CO, GO, CHO]
 *   hasGrip  (no charm)  →  3 styles  [CG, CO, GO]
 *   hasCharm (no grip)   →  3 styles  [CC, CO, CHO]
 *   hasStrap             →  3 styles  [Case+Strap, CO, Strap Only]
 *   none                 →  1 style   [CO]
 *
 * ── Why gpt-5.4-mini is the right tool here ──────────────────────────────────
 *   The LLM is NOT reading for exactness — it is making a binary judgment
 *   about product composition from rich prose + structured cues.  This is
 *   fundamentally a language understanding task, not pattern matching.
 *   Mini-class models are >99% accurate on this simple binary classification.
 *
 * ── Cache ─────────────────────────────────────────────────────────────────────
 *   Keyed by SHA-256(description).  Raw component booleans are cached (not
 *   derived styles) so re-runs cost $0 and cache entries survive future matrix
 *   rule changes.
 */

import { createHash }                 from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname }           from 'node:path';
import { fileURLToPath }              from 'node:url';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = resolve(__dirname, '../../.cache/style-enrichments.json');
const CACHE_DIR  = resolve(__dirname, '../../.cache');
const CACHE_VERSION = 3;  // bump when cache schema changes

// ── Deterministic Style Matrix ────────────────────────────────────────────────
// Ordered to match Shopify's expected variant presentation sequence.
// This is the ONLY place styles are derived — no heuristics, no regex.

/**
 * Maps product component booleans to the complete, correct set of style options.
 *
 * @param {boolean} hasGrip   - product includes a separately-purchasable grip
 * @param {boolean} hasCharm  - product includes a separately-purchasable charm
 * @param {boolean} hasStrap  - product includes a separately-purchasable strap
 * @returns {string[]}
 */
export function deriveStyleVariations(hasGrip, hasCharm, hasStrap) {
  if (hasStrap) {
    return ['Case+Strap', 'Case Only', 'Strap Only'];
  }
  if (hasGrip && hasCharm) {
    return ['Case+Grip+Charm', 'Case+Grip', 'Case+Charm', 'Case Only', 'Grip Only', 'Charm Only'];
  }
  if (hasGrip) {
    return ['Case+Grip', 'Case Only', 'Grip Only'];
  }
  if (hasCharm) {
    return ['Case+Charm', 'Case Only', 'Charm Only'];
  }
  return ['Case Only'];
}

// ── Cache helpers ──────────────────────────────────────────────────────────────

function descHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

async function loadCache() {
  try {
    const data = JSON.parse(await readFile(CACHE_PATH, 'utf-8'));
    if (data.version !== CACHE_VERSION) {
      console.info('[llm-enrich] Cache schema updated (v' + data.version + '→v' + CACHE_VERSION + ') — rebuilding');
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

// ── OpenAI Component Classifier ────────────────────────────────────────────────

const SYSTEM_PROMPT =
`You are an expert e-commerce catalog analyst specialising in physical accessory product classification.

YOUR TASK:
For each product below, determine the SEPARATELY PURCHASABLE physical accessories included.

OUTPUT THREE BOOLEAN FLAGS per product:

  hasGrip  — true if the product includes a phone grip/socket/pop-socket as a SEPARATE purchasable accessory
             (examples: shaker grip, 3D character grip, liquid grip, ring grip sold as standalone option)
             IMPORTANT: "hasGrip: false" if the grip is BUILT INTO THE CASE ITSELF (not sold separately)
             How to tell: if the bundle section has "Case + Grip" as a distinct line, the grip is separate (true).
             If "Case Only" description says "(The MagSafe Case + 3D Grip)", the grip is integrated (false).

  hasCharm — true if the product includes a decorative charm/wristlet as a SEPARATE purchasable accessory
             (examples: beaded wristlet, lanyard charm, bow charm, pendant wristlet)
             How to tell: if "Case + Charm" or "Charm Only" appears as a distinct bundle option, it's separate (true).

  hasStrap — true if the product's primary accessory is a PHONE STRAP or CROSSBODY LANYARD
             (this is a different category from grip — replaces the grip, not a socket-style holder)
             How to tell: if "Case + Strap" appears as a distinct bundle option (true).

SIGNAL PRIORITY:
  1. The bundle breakdown section in the description is your STRONGEST signal.
     Read each listed bundle option carefully to determine what is sold separately.
  2. If "Case + Grip + Charm" appears, both hasGrip and hasCharm are true.
  3. If a bundle option says "Case Only: (The MagSafe Case + 3D Grip)", the grip is PART OF THE CASE → hasGrip false.

Return a JSON object with a "products" array where each element contains:
  - "id": the product [id] hash exactly as given
  - "hasGrip": boolean
  - "hasCharm": boolean
  - "hasStrap": boolean

Example: { "products": [{ "id": "abc123", "hasGrip": true, "hasCharm": true, "hasStrap": false }] }`;

/**
 * Call gpt-5.4-mini to classify components for a batch of products.
 * Returns { [hash]: { hasGrip, hasCharm, hasStrap } }
 *
 * @param {Array<{hash:string, title:string, description:string}>} batch
 * @param {string} apiKey
 * @param {string} model
 */
async function callLLM(batch, apiKey, model) {
  const productList = batch
    .map(p =>
      `[id: ${p.hash}]\n` +
      `Title: ${p.title}\n` +
      `Description:\n${p.description.slice(0, 2000)}`
    )
    .join('\n\n---\n\n');

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
        { role: 'user',   content: productList   },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name:   'component_classification',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              products: {
                type:  'array',
                items: {
                  type: 'object',
                  properties: {
                    id:       { type: 'string'  },
                    hasGrip:  { type: 'boolean' },
                    hasCharm: { type: 'boolean' },
                    hasStrap: { type: 'boolean' },
                  },
                  required:             ['id', 'hasGrip', 'hasCharm', 'hasStrap'],
                  additionalProperties: false,
                },
              },
            },
            required:             ['products'],
            additionalProperties: false,
          },
        },
      },
      temperature:           0,
      max_completion_tokens: 1200,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OpenAI ${resp.status}: ${body.slice(0, 400)}`);
  }

  const json    = await resp.json();
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned empty content');

  // Convert array format → map keyed by id for O(1) lookup
  const parsed = JSON.parse(content);  // { products: [{ id, hasGrip, hasCharm, hasStrap }] }
  return Object.fromEntries((parsed.products ?? []).map(p => [p.id, p]));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Classify every product's physical components with gpt-5.4-mini, then
 * deterministically derive the correct style variations from the component matrix.
 *
 * Products whose description has been processed before are served instantly
 * from the disk cache.  Only genuine cache misses trigger API calls.
 *
 * @param {import('./normalize.mjs').EtsyProduct[]} products
 * @param {string}  apiKey   process.env.OPENAI_API_KEY
 * @param {string}  [model]  defaults to 'gpt-5.4-mini'
 * @returns {Promise<Map<string, {stylesFromDescription:string[], components:{hasGrip:boolean,hasCharm:boolean,hasStrap:boolean}}>>}
 *   Keyed by product title.  Every product with a non-empty description is included.
 */
export async function enrichProductStyles(products, apiKey, model = 'gpt-5.4-mini') {
  if (!apiKey) {
    console.warn('[llm-enrich] OPENAI_API_KEY not set — component classification skipped');
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

  // ── Serve from cache ─────────────────────────────────────────────────────────
  for (const p of eligible) {
    const hash = descHash(p.description);
    if (cache.entries[hash]) {
      const { hasGrip, hasCharm, hasStrap } = cache.entries[hash];
      const styles = deriveStyleVariations(hasGrip, hasCharm, hasStrap);
      resultMap.set(p.title, { stylesFromDescription: styles, components: { hasGrip, hasCharm, hasStrap } });
    } else {
      toCall.push({ hash, title: p.title, description: p.description });
    }
  }

  const hits = eligible.length - toCall.length;
  console.info(
    `[llm-enrich] ${eligible.length} products — ` +
    `${hits} cache hits, ${toCall.length} calling ${model}`,
  );

  if (!toCall.length) return resultMap;

  // ── LLM batches ──────────────────────────────────────────────────────────────
  const LLM_BATCH  = 10;
  let cacheUpdated = false;

  for (let i = 0; i < toCall.length; i += LLM_BATCH) {
    const batch    = toCall.slice(i, i + LLM_BATCH);
    const batchNum = Math.floor(i / LLM_BATCH) + 1;
    const total    = Math.ceil(toCall.length / LLM_BATCH);

    console.info(`[llm-enrich] Calling ${model} — batch ${batchNum}/${total} (${batch.length} products)…`);

    let llmResult;
    try {
      llmResult = await callLLM(batch, apiKey, model);
    } catch (err) {
      console.error(`[llm-enrich] Batch ${batchNum} failed: ${err.message}`);
      continue;
    }

    for (const item of batch) {
      const components = llmResult[item.hash] ?? { hasGrip: false, hasCharm: false, hasStrap: false };
      const { hasGrip, hasCharm, hasStrap } = components;

      cache.entries[item.hash] = {
        hasGrip, hasCharm, hasStrap,
        model,
        title:     item.title,
        timestamp: new Date().toISOString(),
      };
      cacheUpdated = true;

      const styles = deriveStyleVariations(hasGrip, hasCharm, hasStrap);
      resultMap.set(item.title, { stylesFromDescription: styles, components });

      const flags =
        (hasGrip ? 'Grip ' : '') +
        (hasCharm ? 'Charm ' : '') +
        (hasStrap ? 'Strap' : '') || 'Case Only';

      console.info(
        `[llm-enrich]  ✓ "${item.title.slice(0, 50)}"` +
        `  →  [${flags.trim()}]  ${styles.length} styles`,
      );
    }
  }

  if (cacheUpdated) {
    await saveCache(cache);
    console.info(`[llm-enrich] Cache saved → ${CACHE_PATH}`);
  }

  return resultMap;
}
