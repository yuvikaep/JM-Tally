# JM Tally

**JM Tally** is a full **web application** for Indian SMEs: double-entry style ledger, sales invoices, GST helpers, bank statement import, multi-company workspaces, and an optional AI assistant. The UI is **React** + **Vite**; books are **local-first** in the browser today, with room to plug in a shared backend when you ship other clients.

## Platforms

| Platform | Status |
| -------- | ------ |
| **Web** | Primary — this repository |
| **Mobile** | Planned — same product (e.g. React Native / Expo or native apps) against a future API + sync |
| **Desktop** | Planned — e.g. Electron or Tauri shell loading the web app or a dedicated desktop build |

Deploy the web app to any host that can run **Node** (build + `npm start`) or to **static + CDN** hosts that serve `dist/` with SPA fallback.

## Run locally

```bash
npm install
npm run dev
```

## Production build

```bash
npm install
npm run build
npm start
```

`npm start` runs **`server.mjs`**: serves `dist/` and injects the Anthropic key into each HTML response from **`process.env`** (so **Render** can use `VITE_ANTHROPIC_API_KEY` without redeploying a new build when you rotate the key — restart the service). **Vercel** / **Netlify** static deploys only get the key if it was baked in at `vite build` time, unless you add similar runtime config.

## Environment

Optional: **`VITE_ANTHROPIC_API_KEY`** (or **`ANTHROPIC_API_KEY`**) for live AI chat.

- **Local dev:** `.env` + `npm run dev` (Vite reads `VITE_*`).
- **Render (this repo’s `npm start`):** set **`VITE_ANTHROPIC_API_KEY`** in the service Environment, then deploy once with the new `server.mjs`; after that, changing the key only needs a **service restart**.

## Deploy (Render)

**Blueprint:** connect the repo; `render.yaml` defines a **Node Web Service** (`npm run build` → `npm start`).

**Manual:** New → **Web Service** → Node, **Build:** `npm install && npm run build`, **Start:** `npm start`.
