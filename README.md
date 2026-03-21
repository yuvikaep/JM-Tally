# JM Tally

**JM Tally** is a full **web application** for Indian SMEs: double-entry style ledger, sales invoices, GST helpers, bank statement import, multi-company workspaces, and an optional **OpenAI**-powered assistant. The UI is **React** + **Vite**; books are **local-first** in the browser today.

## Platforms

| Platform | Status |
| -------- | ------ |
| **Web** | Primary — this repository |
| **Mobile** | Planned |
| **Desktop** | Planned |

**AI chat** uses **OpenAI** only. Keys: **https://platform.openai.com/api-keys**

## Run locally

```bash
npm install
npm run dev
```

Add **`OPENAI_API_KEY`** to **`.env`** for the dev proxy (or paste a key in the app under **OpenAI API key**).

## Production build

```bash
npm install
npm run build
npm start
```

`npm start` runs **`server.mjs`**: serves `dist/`, proxies **`/api/openai/v1/chat/completions`**, injects **`OPENAI_API_KEY`** into HTML from **`process.env`** (restart after rotating the key).

| Variable | Purpose |
| -------- | ------- |
| **`OPENAI_API_KEY`** | Preferred on **Render** / **Vercel** (secret stays on the server). |
| `VITE_OPENAI_API_KEY` | Optional; can embed in client bundle — avoid for production if you can use server env only. |
| `OPENAI_CHAT_MODEL` / `VITE_OPENAI_CHAT_MODEL` | Default model: **`gpt-4o-mini`**. |

## Deploy (Render)

1. **Web Service** (Node), **not** Static Site.  
2. **Build:** `npm install && npm run build` · **Start:** `npm start`  
3. **Environment:** **`OPENAI_API_KEY`** from **https://platform.openai.com/api-keys**  
4. **Restart** the service after changing env.

Blueprint: **`render.yaml`**.

## Deploy (Vercel)

1. **`OPENAI_API_KEY`** in **Project → Settings → Environment Variables**.  
2. **Redeploy.** Serverless handler: **`api/openai/v1/chat/completions.js`**.  
3. **`vercel.json`** keeps **`/api/*`** off the SPA rewrite.
