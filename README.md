# JM Tally

**JM Tally** is a full **web application** for Indian SMEs: double-entry style ledger, sales invoices, GST helpers, bank statement import, multi-company workspaces, and a **built-in** (no API key) accounting assistant. The UI is **React** + **Vite**; books are **local-first** in the browser today.

## Platforms

| Platform | Status |
| -------- | ------ |
| **Web** | Primary — this repository |
| **Mobile** | Planned |
| **Desktop** | Planned |

**AI chat** uses **embedded rules** plus your **live ledger** in the browser — no OpenAI or other cloud LLM keys.

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

`npm start` runs **`server.mjs`**, which serves **`dist/`** with SPA fallback (suitable for **Render** and similar Node hosts).

## Deploy (Render)

1. **Web Service** (Node), **not** Static Site.  
2. **Build:** `npm install && npm run build` · **Start:** `npm start`  
3. No AI-related environment variables are required.

Blueprint: **`render.yaml`**.

## Deploy (Vercel)

1. Connect the repo; **`vercel.json`** keeps **`/api/*`** off the SPA rewrite (reserved for future server routes).  
2. **Redeploy** after changes.
