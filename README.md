# JM Tally

**JM Tally** is a full **web application** for Indian SMEs: double-entry style ledger, sales invoices, GST helpers, bank statement import, multi-company workspaces, and an optional AI assistant. The UI is **React** + **Vite**; books are **local-first** in the browser today, with room to plug in a shared backend when you ship other clients.

## Platforms

| Platform | Status |
| -------- | ------ |
| **Web** | Primary — this repository |
| **Mobile** | Planned — same product (e.g. React Native / Expo or native apps) against a future API + sync |
| **Desktop** | Planned — e.g. Electron or Tauri shell loading the web app or a dedicated desktop build |

For **AI chat**, use a **Node** host with **`npm start`** (see [Deploy (Render)](#deploy-render) — **Option A**). Plain **static / CDN** deploys do not run `server.mjs`, so there is no `/api` proxy or runtime key injection unless users paste a key in the browser.

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

Optional: **`ANTHROPIC_API_KEY`** or **`VITE_ANTHROPIC_API_KEY`** for live AI chat (same value; pick one).

- **Local dev:** `.env` with either name + `npm run dev` (Vite proxy reads both). For `npm run build && npm start` locally, `server.mjs` reads **`process.env`** at runtime.
- **Render Option A:** set **`ANTHROPIC_API_KEY`** or **`VITE_ANTHROPIC_API_KEY`** on the **Web Service** → **Environment**, then **Save** and **Manual Deploy** (or push). Rotating the key only needs a **restart** — no rebuild.

## Deploy (Render) — Option A (recommended for AI chat)

Use a **Web Service** (Node), **not** a **Static Site**.

1. **New** → **Web Service** (or **Blueprint** from this repo’s `render.yaml`).
2. **Build command:** `npm install && npm run build`
3. **Start command:** `npm start` (runs `server.mjs` on `0.0.0.0:$PORT`, serves `dist/`, proxies `/api/anthropic/v1/messages`, injects the key into HTML).
4. **Environment:** add **`ANTHROPIC_API_KEY`** *or* **`VITE_ANTHROPIC_API_KEY`** (your Anthropic secret from [console.anthropic.com](https://console.anthropic.com)).
5. Deploy, then open **Logs**: you should **not** see `[jm-tally] ... not set` if the variable is wired to this service.

**Blueprint:** connect the repo; `render.yaml` defines the Web Service above.

**Manual:** New → **Web Service** → Node, **Build:** `npm install && npm run build`, **Start:** `npm start`.
