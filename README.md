# Y2KASE — Shopify

Theme and Admin API tooling for the Y2KASE Shopify store.  
Includes a full **Etsy → Shopify ETL pipeline** and a **local audit dashboard** for reviewing products before they go live.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Installation](#2-installation)
3. [Environment setup](#3-environment-setup)
4. [Refreshing your API token](#4-refreshing-your-api-token)
5. [Option A — Local Audit Dashboard (recommended)](#5-option-a--local-audit-dashboard-recommended)
6. [Option B — CLI Import](#6-option-b--cli-import)
7. [What the pipeline does](#7-what-the-pipeline-does)
8. [After the import](#8-after-the-import)
9. [Troubleshooting](#9-troubleshooting)
10. [File reference](#10-file-reference)

---

## 1. Prerequisites

| Requirement | Version |
|---|---|
| Node.js | 20 or later |
| npm | 9 or later |
| Shopify Custom App | must have `write_products`, `read_products`, `write_inventory`, `read_locations` scopes |

---

## 2. Installation

```bash
npm ci
```

---

## 3. Environment setup

Copy the example file and fill in every value:

```bash
cp .env.example .env
```

`.env` must contain:

```
SHOPIFY_SHOP=your-store.myshopify.com
SHOPIFY_CLIENT_ID=<from your Custom App dashboard>
SHOPIFY_CLIENT_SECRET=<from your Custom App dashboard>
SHOPIFY_ADMIN_ACCESS_TOKEN=<refreshed — see step 4>
SHOPIFY_API_VERSION=2025-04
```

> **Never commit `.env` to git.** It is listed in `.gitignore`.

### Place your Etsy CSV

Download your listings from Etsy: **Shop Manager → Listings → Export as CSV**

Rename the file to exactly:

```
EtsyListingsDownload.csv
```

Place it in the **project root** (same folder as `package.json`).

---

## 4. Refreshing your API token

Access tokens expire. **Run this before every import session:**

```bash
npm run refresh-token
```

This fetches a fresh token using your client credentials and writes it directly to `.env`. You do not need to copy anything manually.

---

## 5. Option A — Local Audit Dashboard (recommended)

The dashboard lets you review every product before it is pushed to Shopify. It detects duplicates, shows side-by-side diffs between incoming Etsy data and existing Shopify products, and streams live import progress.

### Start the dashboard

```bash
npm run etsy:dashboard
```

The server starts on `http://localhost:3000` and opens automatically in your browser.

### Dashboard walkthrough

**Status Bar (top)**

Three live indicator pills appear immediately:

| Pill | What it checks |
|---|---|
| Token | Calls `/api/preflight` to verify your Admin API token is valid |
| CSV | Confirms `EtsyListingsDownload.csv` exists and shows the row count |
| Location | Resolves your fulfilment location (`FLAT D 10/F BLOCK 6 LILY MANSION`) to a Shopify GID |

If any pill is red, fix the issue before continuing (see [Troubleshooting](#9-troubleshooting)).

**Product Audit Table (centre)**

Click **Load Preview** to run the full ETL transformation and compare the results against live Shopify data. Each product gets a status badge:

| Badge | Meaning | Default checkbox |
|---|---|---|
| **New** | Does not exist in Shopify yet | ✅ Checked |
| **Conflict** | Exists but data has changed | ⬜ Unchecked — inspect before selecting |
| **Match** | Exists and is identical | Disabled — no action needed |

**Conflict Inspector**

Click **Inspect** on any Conflict row (or click the row itself) to open the side-by-side diff modal.

- Left pane: incoming Etsy data
- Right pane: current Shopify live data
- Changed fields are highlighted in amber

After reviewing, click **Acknowledge & Select** to check the box and include the product in the next import. Click **Skip** to leave it unchecked.

**Running the import**

1. Review your selections in the Audit Table
2. Use the **Filter ▾** button to quickly see only New / Conflict / Match rows
3. Click **Import Selected**
4. Watch live step-by-step progress in the **Import Progress** panel (right side):
   - Each product streams: `productSet → media → inventory`
   - Rate-limit pauses and backoff retries are shown in real time
   - Click **Cancel** at any time to stop the stream safely
5. The **Import History** panel (bottom) logs every completed run

**Refresh Token button**

If the Token pill turns red mid-session, click **Refresh Token** in the status bar. The server exchanges your client credentials for a new access token automatically.

---

## 6. Option B — CLI Import

If you prefer the terminal without the dashboard:

### Dry run — always do this first

```bash
npm run etsy:dry
```

Reads your CSV and prints the exact data that would be sent to Shopify — titles, variants, prices, images, SKUs — **without creating anything in your store.**

Check that:
- Titles look clean (not keyword-stuffed)
- Variant prices match the bundle tiers (`Case+Grip+Charm` ≠ `Case Only`)
- SKUs follow the pattern `Y2K-[CHAR]-[MODEL]-[STYLE]`
- Location shows: `FLAT D 10/F BLOCK 6 LILY MANSION`

### Live import

```bash
npm run etsy:apply
```

Pushes all products to Shopify. For ~40 products expect roughly **4 minutes** total (rate-limit pacing is enforced automatically).

Progress prints in real time:

```
  [ 1/40] ✓  Winnie the Pooh Clear iPhone Case    72 variants · 9 images · 72 inventory
  [ 2/40] ✓  Snoopy Clear iPhone Case              72 variants · 8 images · 72 inventory
  [ 3/40] –  SKIP (already exists)  Tamagotchi Clear iPhone Case…
```

Final summary:

```
  Products created:  38
  Products skipped:   2   (already existed in Shopify)
  Errors:             0
```

### Safe to re-run

If the import crashes halfway, run `etsy:apply` again. Products already created are **automatically skipped** — they will not be duplicated.

---

## 7. What the pipeline does

For every row in `EtsyListingsDownload.csv` the pipeline:

1. Cleans the keyword-stuffed Etsy title into a concise Shopify title
2. Saves the original Etsy title as a hidden SEO metafield
3. Maps the product to a Shopify Product Type and Collection via the taxonomy classifier
4. Builds the full variant matrix — every combination of phone model × style bundle
5. Assigns the correct price per bundle (extracted from the style string or the price matrix)
6. Generates a unique SKU per variant: `Y2K-CHAR-MODEL-STYLE`
7. Sets `inventoryManagement: SHOPIFY` and `inventoryPolicy: DENY` on every variant
8. Pushes the product as **DRAFT** (not visible to customers until you publish)
9. Attaches all Etsy image URLs to the product
10. Sets on-hand stock quantities at `FLAT D 10/F BLOCK 6 LILY MANSION`

---

## 8. After the import

1. Go to **Shopify Admin → Products**
2. All imported products have status **Draft** — invisible to customers
3. Review titles, images, and prices in the Shopify Admin UI
4. Set status to **Active** to make a product visible in your store
5. Collections populate automatically via smart rules — no manual assignment needed

---

## 9. Troubleshooting

| Problem | Fix |
|---|---|
| Token pill is red / `401 Invalid API key` | Run `npm run refresh-token` then reload the dashboard |
| Location pill is red / `Location not found` | Verify the name in Shopify Admin → Settings → Locations exactly matches `FLAT D 10/F BLOCK 6 LILY MANSION` |
| CSV pill is red | Confirm `EtsyListingsDownload.csv` is in the project root and is not empty |
| Dashboard won't open | Make sure port 3000 is free, then run `npm run etsy:dashboard` again |
| `productSet userErrors` | Check the logged field name — usually a SKU conflict or title over 255 characters |
| Product exists but data is wrong | Delete the product in Shopify Admin, then re-run — the pipeline will recreate it |
| Token expires mid-import | Click **Refresh Token** in the dashboard status bar (or run `npm run refresh-token`), then start the import again — already-created products will be skipped |
| Import stream disconnects | The server sends a heartbeat every 10 s; if the browser reconnects, click Cancel and re-run — skipped products are safe |

---

## 10. File reference

### Scripts

| File | Purpose |
|---|---|
| `scripts/etsy-api-import.mjs` | CLI entry point — orchestrates the full ETL pipeline |
| `scripts/lib/csv-parser.mjs` | Streaming CSV parser (handles multi-line fields, BOM) |
| `scripts/lib/normalize.mjs` | Raw CSV row → normalised JS object |
| `scripts/lib/transform.mjs` | Title rewriting, variant matrix, pricing, SKU generation |
| `scripts/lib/loader.mjs` | Shopify API mutations (`productSet`, `productCreateMedia`, `inventorySetOnHandQuantities`) |
| `scripts/shopify-client.mjs` | GraphQL client with leaky-bucket rate limiting and exponential backoff |
| `scripts/get-token.mjs` | OAuth client-credentials token refresh utility |
| `scripts/taxonomy/classifier.mjs` | Character and product-type detection rules |
| `scripts/taxonomy/title-generator.mjs` | Clean title generation logic |

### Dashboard

| File | Purpose |
|---|---|
| `scripts/dashboard/server.mjs` | Express server — API routes, SSE stream, diff logic, history |
| `scripts/dashboard/public/index.html` | Single-page dashboard UI structure |
| `scripts/dashboard/public/dashboard.css` | Dark-neutral theme, CSS Grid layout, CSS variables |
| `scripts/dashboard/public/dashboard.js` | Vanilla JS client — preflight, table, modal, SSE engine, history |
| `scripts/dashboard/import-history.json` | Auto-generated log of past import runs |

### Config & data

| File | Purpose |
|---|---|
| `EtsyListingsDownload.csv` | Your Etsy export — **you provide this** |
| `.env` | Secrets — never commit |
| `.env.example` | Template showing all required variables |
| `ETSY-IMPORT.md` | Legacy CLI-only instructions (superseded by this README) |

---

## npm scripts

| Script | What it does |
|---|---|
| `npm run etsy:dashboard` | Start the local audit dashboard on `http://localhost:3000` |
| `npm run etsy:dry` | Dry-run CLI import — prints payloads, creates nothing |
| `npm run etsy:apply` | Live CLI import — pushes all products to Shopify |
| `npm run refresh-token` | Fetch a new Admin API token and write it to `.env` |
| `npm run dev` | Start Shopify CLI theme development server |
| `npm run push` | Push theme files to Shopify |
| `npm run pull` | Pull theme files from Shopify |
