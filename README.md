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

`npm start` runs **`server.mjs`**: serves `dist/` and injects LLM keys from **`process.env`** into HTML (restart to rotate keys; no rebuild). **Vercel** / **Netlify** static deploys only get keys if baked at `vite build` time, unless you add similar runtime config.

## Environment

**AI chat — pick one or both providers:**

| Provider | Env vars (any one name) | Default model |
| -------- | ------------------------ | ------------- |
| **Claude (Anthropic)** | `ANTHROPIC_API_KEY` or `VITE_ANTHROPIC_API_KEY` | `claude-sonnet-4-20250514` (in app) |
| **OpenAI** | `OPENAI_API_KEY` or `VITE_OPENAI_API_KEY` | `gpt-4o-mini` (override with `OPENAI_CHAT_MODEL` / `VITE_OPENAI_CHAT_MODEL`) |

**Which provider runs:** set **`VITE_CHAT_PROVIDER`** or **`CHAT_PROVIDER`** to `openai` or `anthropic` on the server (injected into the page), or **`VITE_CHAT_PROVIDER`** at build time, or choose in the app under **API keys & provider**. If only one key is configured, that provider is used automatically.

- **Local dev:** `.env` + `npm run dev` (Vite proxies `/api/anthropic/...` and `/api/openai/...`). You can also paste keys in the app (sent as `Authorization: Bearer` to the proxy).
- **Render Option A:** set the keys you need on the **Web Service** → **Environment**, then **restart** after changes.

## Deploy (Render) — Option A (recommended for AI chat)

Use a **Web Service** (Node), **not** a **Static Site**.

1. **New** → **Web Service** (or **Blueprint** from this repo’s `render.yaml`).
2. **Build command:** `npm install && npm run build`
3. **Start command:** `npm start` (runs `server.mjs` on `0.0.0.0:$PORT`, serves `dist/`, proxies Anthropic + OpenAI chat APIs, injects config into HTML).
4. **Environment:** add **`OPENAI_API_KEY`** and/or **`ANTHROPIC_API_KEY`** (or the `VITE_*` names). Optional: **`VITE_CHAT_PROVIDER`** = `openai` | `anthropic` to set the default model.
5. Deploy, then open **Logs**: warnings appear only for providers whose keys are missing (both are optional if you paste a key in the browser).

**Blueprint:** connect the repo; `render.yaml` defines the Web Service above.

**Manual:** New → **Web Service** → Node, **Build:** `npm install && npm run build`, **Start:** `npm start`.
