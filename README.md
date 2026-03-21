# JM Tally

**JM Tally** is a full **web application** for Indian SMEs: double-entry style ledger, sales invoices, GST helpers, bank statement import, multi-company workspaces, and an optional AI assistant. The UI is **React** + **Vite**; books are **local-first** in the browser today, with room to plug in a shared backend when you ship other clients.

## Platforms

| Platform | Status |
| -------- | ------ |
| **Web** | Primary — this repository |
| **Mobile** | Planned — same product (e.g. React Native / Expo or native apps) against a future API + sync |
| **Desktop** | Planned — e.g. Electron or Tauri shell loading the web app or a dedicated desktop build |

For **AI chat**, use a **Node** host with **`npm start`** (see [Deploy (Render)](#deploy-render)) or **Vercel** with the included **`api/`** serverless routes. Plain **static / CDN** deploys without those routes only get chat if users paste a key in the browser.

## Run locally

```bash
npm install
npm run dev
```

Add **`OPENAI_API_KEY`** (and optionally **`CHAT_PROVIDER=anthropic`** for Claude) to **`.env`** for the dev proxy. Keys: **https://platform.openai.com/api-keys**

## Production build

```bash
npm install
npm run build
npm start
```

`npm start` runs **`server.mjs`**: serves `dist/`, proxies **`/api/openai`** and **`/api/anthropic`**, and injects config into HTML from **`process.env`**.

## Environment — AI chat (OpenAI by default)

| What | Env vars | Notes |
| ---- | -------- | ----- |
| **OpenAI (default)** | **`OPENAI_API_KEY`** or `VITE_OPENAI_API_KEY` | Create keys at **https://platform.openai.com/api-keys**. Prefer **`OPENAI_API_KEY`** on the server so the secret is not baked into the JS bundle. |
| **Model** | `OPENAI_CHAT_MODEL` or `VITE_OPENAI_CHAT_MODEL` | Default in app: **`gpt-4o-mini`**. |
| **Use Claude instead** | `ANTHROPIC_API_KEY` or `VITE_ANTHROPIC_API_KEY` | Plus **`CHAT_PROVIDER=anthropic`** (or **`VITE_CHAT_PROVIDER`**) so the app does not stay on OpenAI. |
| **Force provider** | **`CHAT_PROVIDER`** or **`VITE_CHAT_PROVIDER`** | `openai` (default) or `anthropic`. Injected at runtime on Render via `server.mjs`. |

- **Local:** `.env` + `npm run dev` (Vite proxies `/api/openai` and `/api/anthropic`). You can also paste keys in the app under **API keys & provider**.
- **Render:** Web Service + **`npm start`**; set **`OPENAI_API_KEY`** in **Environment**, then **restart** after changes.
- **Vercel:** Set **`OPENAI_API_KEY`** under **Project → Settings → Environment Variables**; redeploy. The **`api/openai/v1/chat/completions.js`** function uses it. Avoid **`VITE_OPENAI_API_KEY`** unless you accept the key in the client bundle.

## Deploy (Render) — Web Service + `npm start`

Use a **Web Service** (Node), **not** a **Static Site**.

1. **New** → **Web Service** (or **Blueprint** from **`render.yaml`**).
2. **Build:** `npm install && npm run build`
3. **Start:** `npm start`
4. **Environment:** **`OPENAI_API_KEY`** = secret from **https://platform.openai.com/api-keys**. Optional: **`CHAT_PROVIDER=anthropic`** and **`ANTHROPIC_API_KEY`** if you want Claude only or both.
5. **Logs:** if OpenAI is unset, you’ll see a warning until **`OPENAI_API_KEY`** is set (default chat is OpenAI).

**Manual:** New → **Web Service** → Node, **Build:** `npm install && npm run build`, **Start:** `npm start`.

## Deploy (Vercel)

1. Set **`OPENAI_API_KEY`** in **Vercel → Environment Variables** (Production / Preview as needed). Keys: **https://platform.openai.com/api-keys**
2. Optional: **`CHAT_PROVIDER=anthropic`** and **`ANTHROPIC_API_KEY`** for Claude.
3. Redeploy. **`vercel.json`** keeps **`/api/*`** off the SPA rewrite so **`api/openai/...`** runs as a serverless function.
4. Remove wrong **`VITE_*`** secrets if you no longer want them embedded in the client build.
