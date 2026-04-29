# Y2KASE — Shopify

Theme and Admin API tooling for the Y2KASE store (Shopify CLI, Node scripts).

## Setup

1. **Node** — Use Node 20+ (`engines` in `package.json`).
2. **Environment** — Copy `.env.example` to `.env` and fill in secrets. Never commit `.env`.
3. **Dependencies** — `npm ci`
4. **Shopify** — `npm run login` (or `shopify auth login`) for theme dev and app commands.

## Useful scripts

See `package.json` — includes `dev`, `push`, `pull`, `refresh-token`, import/audit helpers, and more.

## Version control

- Tracked: theme, `shopify.app.toml`, scripts, lockfile.
- Ignored: `.env`, `.shopify/`, `node_modules/`, build artifacts.
