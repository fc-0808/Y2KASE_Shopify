# Y2KASE — Shopify Store Tooling

Theme development and Admin API tooling for the Y2KASE Shopify store, including a full **Etsy → Shopify import pipeline** with a local audit dashboard.

---

## Quick Start

```bash
# 1. Install dependencies
npm ci

# 2. Copy and fill in secrets
cp .env.example .env

# 3. Refresh your API token (do this before every session)
npm run refresh-token

# 4. Export CSV from Etsy → rename to EtsyListingsDownload.csv → place in data/

# 5. Launch the import dashboard
npm run etsy:dashboard
```

Open `http://localhost:3000` → click **Load Preview** → review → click **Import Selected**.

---

## How the Pipeline Works

```
EtsyListingsDownload.csv
        │
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  EXTRACT                                                         │
│  csv-parser.mjs      Streaming parse, handles BOM + multi-line  │
│  normalize.mjs       Raw row → clean EtsyProduct object          │
└─────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  ENRICH  (optional — requires OPENAI_API_KEY)                    │
│  llm-enrich.mjs      GPT detects grip/charm/strap from desc      │
│                      → sets stylesFromDescription on product      │
└─────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  TRANSFORM                                                       │
│  classifier.mjs      Detects character, IP, style, attachment,  │
│                      aesthetic, feature from title + tags        │
│  title-generator.mjs Rewrites keyword-stuffed Etsy title to     │
│                      clean ≤70-char Shopify title                │
│  collection-logic.mjs Maps classification → collection GIDs     │
│  transform.mjs       Assembles the full ProductSetInput payload  │
│                        • Variant matrix  (model × style)         │
│                        • Per-bundle pricing                      │
│                        • SKUs  Y2K-CHAR-MODEL-STYLE              │
│                        • Custom metafields (etsy_title, SEO)     │
│                        • Category metafields (25 taxonomy attrs) │
│                        • SEO title + description                 │
│  category-metafields.mjs  Maps signals → taxonomy value GIDs   │
└─────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  LOAD                                                            │
│  loader.mjs          Three-step Shopify mutation sequence:       │
│    Step 1  productSet             Creates product + variants     │
│    Step 2  productCreateMedia     Attaches Etsy image URLs       │
│    Step 3  inventorySetOnHandQty  Sets stock at your location    │
│  shopify-client.mjs  Rate limiter + exponential backoff          │
└─────────────────────────────────────────────────────────────────┘
        │
        ▼
Shopify store — products created as DRAFT, ready to review + publish
```

---

## Requirements

| Requirement | Version |
|---|---|
| Node.js | 20 or later |
| npm | 9 or later |
| Shopify Custom App scopes | `write_products` `read_products` `write_inventory` `read_locations` |

---

## Setup

### 1. Environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in every value:

```
SHOPIFY_SHOP=your-store.myshopify.com
SHOPIFY_CLIENT_ID=<from Custom App dashboard>
SHOPIFY_CLIENT_SECRET=<from Custom App dashboard>
SHOPIFY_ADMIN_ACCESS_TOKEN=<run npm run refresh-token to generate>
SHOPIFY_API_VERSION=2026-04
OPENAI_API_KEY=<optional — enables LLM style detection>
```

> `.env` is in `.gitignore`. Never commit it.

### 2. Etsy CSV

In Etsy: **Shop Manager → Listings → Export as CSV**

Rename the exported file to **exactly**:

```
EtsyListingsDownload.csv
```

Place it in the **`data/`** folder (not the project root).

### 3. Taxonomy cache (one-time, already done)

The import pipeline fills 25 Shopify "Category metafields" automatically. The valid taxonomy value GIDs are cached locally:

```bash
node scripts/lib/fetch-taxonomy-attrs.mjs
```

Re-run this only if Shopify updates their product taxonomy (rare).

---

## Running an Import

### Option A — Dashboard (recommended)

```bash
npm run etsy:dashboard
```

Opens `http://localhost:3000` automatically.

**Status bar** — three pills validate your setup before anything runs:

| Pill | What it checks |
|---|---|
| Token | Admin API token is valid |
| CSV | `EtsyListingsDownload.csv` exists and has rows |
| Location | Resolves your fulfilment location to a Shopify GID |

**Load Preview** — runs the full ETL transform and diffs incoming data against what's already in your store. Each product gets a badge:

| Badge | Meaning | Default |
|---|---|---|
| **New** | Doesn't exist in Shopify | ✅ Selected |
| **Conflict** | Exists but data changed | ⬜ Review first |
| **Match** | Identical — nothing to do | Disabled |

Click **Inspect** on any Conflict to open a side-by-side diff (incoming vs. live Shopify). Acknowledge or skip per product.

**Import Selected** — streams live progress per product:
```
productSet → productCreateMedia → inventorySetOnHandQuantities
```

Click **Cancel** to stop safely at any time. Re-running skips already-created products.

---

### Option B — CLI

```bash
# Dry run — prints everything, creates nothing
npm run etsy:dry

# Live import
npm run etsy:apply
```

---

## After the Import

1. **Shopify Admin → Products** — all imported products are **DRAFT** (invisible to customers)
2. Review titles, images, and prices
3. Set status to **Active** to publish

Collections populate automatically — no manual assignment needed.

---

## All npm Scripts

### Import pipeline

| Script | What it does |
|---|---|
| `npm run etsy:dashboard` | Launch the local audit dashboard on `http://localhost:3000` |
| `npm run etsy:dry` | Dry-run CLI import — prints payloads, creates nothing |
| `npm run etsy:apply` | Live CLI import — pushes all products to Shopify |
| `npm run refresh-token` | Fetch a new Admin API token and write it to `.env` |

### Post-import tools

| Script | What it does |
|---|---|
| `npm run import:dry` | Dry-run the post-import pipeline (title/tag/type fixes) |
| `npm run import:apply` | Apply post-import fixes to all products |
| `npm run import:new` | Apply post-import fixes to new-only products |
| `npm run fix:all` | Fix inventory levels AND sale pricing |
| `npm run fix:inventory` | Fix inventory levels only |
| `npm run fix:pricing` | Fix sale pricing only |
| `npm run fix:dry` | Dry-run the fix pipeline |
| `npm run audit` | Full store audit report |

### Taxonomy / collections

| Script | What it does |
|---|---|
| `npm run taxonomy:dry` | Preview taxonomy + collection setup |
| `npm run taxonomy:apply` | Apply taxonomy tags and product types |
| `npm run taxonomy:collections` | Create/update smart collections only |

### Theme development

| Script | What it does |
|---|---|
| `npm run dev` | Shopify CLI theme dev server (live preview) |
| `npm run push` | Push theme files to Shopify |
| `npm run pull` | Pull theme files from Shopify |
| `npm run push:theme` | Push via Admin API (no CLI required) |

---

## File Map

### Core pipeline — `scripts/`

| File | Role |
|---|---|
| `etsy-api-import.mjs` | **CLI entry point** — orchestrates the full ETL for `etsy:dry` / `etsy:apply` |
| `shopify-client.mjs` | Shared GraphQL client — rate limiter, exponential backoff, token loading |
| `get-token.mjs` | OAuth client-credentials token refresh |
| `post-import-pipeline.mjs` | Post-import fixes — title rewrites, product type, tags (GraphQL `productSet`) |
| `fix-inventory-and-pricing.mjs` | Bulk inventory + sale-price corrections (GraphQL `productVariantsBulkUpdate`) |

### Library — `scripts/lib/`

| File | Role |
|---|---|
| `csv-parser.mjs` | Streaming CSV parser — handles BOM, multi-line fields, encoding |
| `normalize.mjs` | Raw CSV row → typed `EtsyProduct` object |
| `transform.mjs` | **Core transform** — title, variants, pricing, SKUs, metafields, SEO, category |
| `loader.mjs` | **Core loader** — `productSet` → `productCreateMedia` → `inventorySetOnHandQuantities` |
| `llm-enrich.mjs` | Optional GPT enrichment — detects grip/charm from product description |
| `collection-logic.mjs` | Maps classification signals → collection GIDs for `collectionsToJoin` |
| `category-metafields.mjs` | Maps classification → 25 Shopify taxonomy category metafield values |
| `fetch-taxonomy-attrs.mjs` | One-time script — queries live Shopify taxonomy API, writes `.cache/taxonomy-attrs-cache.json` |

### Taxonomy engine — `scripts/taxonomy/`

| File | Role |
|---|---|
| `classifier.mjs` | Rule-based classifier — detects character, IP, style, attachment, aesthetic, features |
| `title-generator.mjs` | Generates clean `≤70-char` Shopify title from classification + Etsy title |
| `collections-schema.mjs` | Authoritative collection definitions and GID map |
| `setup-taxonomy.mjs` | Apply product types, tags, and smart collections across the store |

### Dashboard — `scripts/dashboard/`

| File | Role |
|---|---|
| `server.mjs` | Express server — preflight, preview/diff, SSE import stream, history, override routes |
| `public/index.html` | Single-page dashboard UI |
| `public/dashboard.css` | Dark-neutral theme, CSS Grid, CSS custom properties |
| `public/dashboard.js` | Vanilla JS client — status pills, audit table, diff modal, SSE engine, history panel |

### Utility scripts — `scripts/`

| File | Role |
|---|---|
| `store-audit.mjs` | Full product/collection/policy audit report |
| `list-products.mjs` | List all products via GraphQL |
| `list-orders.mjs` | List recent orders |
| `set-inventory-levels.mjs` | Force-refresh inventory levels |
| `graphql-republish.mjs` | Republish products via `productSet` (DRAFT → ACTIVE) |
| `republish-products.mjs` | Bulk republish utility |
| `setup-store-content.mjs` | Set up pages, navigation menus, and store policies |
| `check-markets.mjs` | Verify international market configuration |
| `update-menus.mjs` | Update storefront navigation menus |
| `fix-policies.mjs` | Sync store policies |

### Data files — `data/`

| File | Role |
|---|---|
| `EtsyListingsDownload.csv` | **You provide this** — Etsy export, renamed exactly |
| `import-history.json` | Auto-generated on first import run — log of every run (gitignored) |

### Cache — `.cache/`

| File | Role |
|---|---|
| `taxonomy-attrs-cache.json` | Auto-generated — live Shopify taxonomy value GIDs |
| `style-enrichments.json` | Auto-generated — LLM enrichment results keyed by description hash |

> `.cache/` is gitignored. Regenerate caches with `node scripts/lib/fetch-taxonomy-attrs.mjs`.

### Docs — `docs/`

| File | Role |
|---|---|
| `info.txt` | Store credentials reference |
| `price.png` | Pricing reference screenshot |
| `ETSY-IMPORT.md` | Legacy import guide (see README for current process) |

### Root config

| File | Role |
|---|---|
| `.env` | **Secrets — never commit** |
| `.env.example` | Template with all required variable names |
| `package.json` | npm scripts and dependencies |
| `shopify.app.toml` | Shopify CLI app configuration |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Token pill red / `401 Unauthorized` | Run `npm run refresh-token` then reload |
| Location pill red | Verify the name in Shopify Admin → Settings → Locations exactly matches `FLAT D 10/F BLOCK 6 LILY MANSION` |
| CSV pill red | Confirm `data/EtsyListingsDownload.csv` exists and is not empty |
| `Port 3000 is already in use` | Another server process is running — restart your terminal or kill port 3000 |
| `productSet userErrors` | Check the logged field — usually a SKU collision or title over 255 chars |
| `@idempotent directive required` | Your API version is 2026-04+ — already fixed; ensure `SHOPIFY_API_VERSION=2026-04` in `.env` |
| `Invalid productTaxonomyNodeId` | GID format changed — already fixed to `TaxonomyCategory/el-4-8-4-2` |
| Category metafields empty after import | Run `node scripts/lib/fetch-taxonomy-attrs.mjs` to warm the taxonomy cache |
| Product exists with wrong data | Delete it in Shopify Admin → re-run import — the pipeline recreates it cleanly |
| Import crashes halfway | Re-run `npm run etsy:apply` — already-created products are skipped automatically |
| Stream disconnects mid-import | Click Cancel → re-run — the server heartbeats every 10 s, completed products are safe |

---

## Architecture Notes

**API version:** All mutations use Shopify Admin GraphQL API `2026-04`.

**Idempotency:** Products are de-duplicated by handle. `inventorySetOnHandQuantities` uses `crypto.randomUUID()` per batch to satisfy the `@idempotent` directive requirement.

**Category:** All products are filed under `gid://shopify/TaxonomyCategory/el-4-8-4-2` — *Electronics > Communications > Telephony > Mobile & Smart Phone Accessories > Mobile Phone Cases*.

**Category metafields:** 25 taxonomy attributes are auto-populated per product by mapping classifier signals (attachment type, case style, IP brand, aesthetic) to official Shopify `TaxonomyValue` GIDs. Uses `list.product_taxonomy_value_reference` metafield type in the `shopify` namespace.

**Inventory:** All stock is tracked at `FLAT D 10/F BLOCK 6 LILY MANSION`. `inventoryPolicy: DENY` prevents overselling.

**Drafts:** Every imported product is created as `status: DRAFT`. Nothing goes live until you manually publish in Shopify Admin.
