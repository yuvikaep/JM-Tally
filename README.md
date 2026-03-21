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

`npm start` serves `dist/` (used by **Render Web Service** and similar). **Vercel** / **Netlify** can use `dist` as the publish folder without `npm start`.

## Environment

Optional: `VITE_ANTHROPIC_API_KEY` in `.env` for live AI assistant replies (see `.env.example`). On Render, set this in the service **Environment** so it is available at **build** time (Vite inlines `VITE_*` variables).

## Deploy (Render)

**Blueprint:** connect the repo; `render.yaml` defines a **Node Web Service** (`npm run build` → `npm start`).

**Manual:** New → **Web Service** → Node, **Build:** `npm install && npm run build`, **Start:** `npm start`.
