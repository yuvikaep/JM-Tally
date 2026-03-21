/**
 * Production static server for Render (and similar).
 * Injects LLM API keys from process.env into index.html at request time
 * and proxies /api/anthropic/* and /api/openai/* so keys can stay off the client when possible.
 */
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, "dist")
const PORT = Number(process.env.PORT) || 4173

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".map": "application/json",
  ".woff2": "font/woff2",
}

function injectRuntimeConfig(html) {
  const anthropicApiKey = String(process.env.VITE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || "").trim()
  const openaiApiKey = String(process.env.VITE_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "").trim()
  const chatProvider = String(process.env.VITE_CHAT_PROVIDER || process.env.CHAT_PROVIDER || "").trim()
  const payload = JSON.stringify({ anthropicApiKey, openaiApiKey, chatProvider })
  const tag = `<script>window.__JM_TALLY_CONFIG__=${payload}</script>`
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${tag}</head>`)
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${tag}</body>`)
  return tag + html
}

const rootResolved = path.resolve(root)
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"

function getAnthropicKey() {
  return String(process.env.VITE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || "").trim()
}

function getOpenAIKey() {
  return String(process.env.VITE_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "").trim()
}

function getOpenAIChatModel() {
  return String(process.env.OPENAI_CHAT_MODEL || process.env.VITE_OPENAI_CHAT_MODEL || "gpt-4o-mini").trim()
}

/** POST /api/anthropic/v1/messages — forward JSON body to Anthropic (key stays on server). */
function handleAnthropicProxy(req, res) {
  const key = getAnthropicKey()
  if (!key) {
    res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" })
    res.end(JSON.stringify({ error: { message: "ANTHROPIC_API_KEY / VITE_ANTHROPIC_API_KEY not set on server" } }))
    return
  }
  const chunks = []
  req.on("data", c => chunks.push(c))
  req.on("end", async () => {
    try {
      const body = chunks.length ? Buffer.concat(chunks).toString("utf8") : "{}"
      const r = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body,
      })
      const txt = await r.text()
      const ct = r.headers.get("content-type") || "application/json; charset=utf-8"
      res.writeHead(r.status, { "Content-Type": ct })
      res.end(txt)
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" })
      res.end(JSON.stringify({ error: { message: String(e?.message || e) } }))
    }
  })
}

/** POST /api/openai/v1/chat/completions — Bearer from client request or server env. */
function handleOpenAIProxy(req, res) {
  const auth = String(req.headers.authorization || "")
  const fromClient = auth.startsWith("Bearer ") ? auth.slice(7).trim() : ""
  const key = fromClient || getOpenAIKey()
  if (!key) {
    res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" })
    res.end(
      JSON.stringify({
        error: {
          message:
            "No OpenAI key: send Authorization: Bearer sk-… from the app, or set OPENAI_API_KEY / VITE_OPENAI_API_KEY on the server.",
        },
      })
    )
    return
  }
  const chunks = []
  req.on("data", c => chunks.push(c))
  req.on("end", async () => {
    try {
      let body = chunks.length ? Buffer.concat(chunks).toString("utf8") : "{}"
      let parsed
      try {
        parsed = JSON.parse(body)
      } catch {
        parsed = {}
      }
      if (!parsed.model) parsed.model = getOpenAIChatModel()
      body = JSON.stringify(parsed)
      const r = await fetch(OPENAI_CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body,
      })
      const txt = await r.text()
      const ct = r.headers.get("content-type") || "application/json; charset=utf-8"
      res.writeHead(r.status, { "Content-Type": ct })
      res.end(txt)
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" })
      res.end(JSON.stringify({ error: { message: String(e?.message || e) } }))
    }
  })
}

function safeFileFromUrlPath(urlPath) {
  const clean = String(urlPath || "").replace(/^\/+/, "")
  const parts = clean.split("/").filter(p => p && p !== "." && p !== "..")
  if (parts.length === 0) return path.join(rootResolved, "index.html")
  const full = path.resolve(rootResolved, ...parts)
  const rel = path.relative(rootResolved, full)
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null
  return full
}

const server = http.createServer((req, res) => {
  try {
    const host = req.headers.host || "localhost"
    const url = new URL(req.url || "/", `http://${host}`)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === "/api/anthropic/v1/messages" && req.method === "POST") {
      handleAnthropicProxy(req, res)
      return
    }
    if (pathname === "/api/openai/v1/chat/completions" && req.method === "POST") {
      handleOpenAIProxy(req, res)
      return
    }
    const filePath = pathname === "/" ? path.join(rootResolved, "index.html") : safeFileFromUrlPath(pathname)
    if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      if (path.extname(filePath) === ".html") {
        const html = fs.readFileSync(filePath, "utf8")
        res.writeHead(200, { "Content-Type": MIME[".html"] })
        res.end(injectRuntimeConfig(html))
        return
      }
      const ext = path.extname(filePath)
      const ct = MIME[ext] || "application/octet-stream"
      res.writeHead(200, { "Content-Type": ct })
      res.end(fs.readFileSync(filePath))
      return
    }

    const indexPath = path.join(root, "index.html")
    if (!fs.existsSync(indexPath)) {
      res.writeHead(500, { "Content-Type": "text/plain" })
      res.end("dist/index.html missing — run npm run build first")
      return
    }
    const html = fs.readFileSync(indexPath, "utf8")
    res.writeHead(200, { "Content-Type": MIME[".html"] })
    res.end(injectRuntimeConfig(html))
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" })
    res.end(String(e?.message || e))
  }
})

server.listen(PORT, "0.0.0.0", () => {
  console.log(`JM Tally listening on 0.0.0.0:${PORT}`)
  if (!getAnthropicKey())
    console.warn(
      "[jm-tally] ANTHROPIC_API_KEY / VITE_ANTHROPIC_API_KEY not set — Claude /api proxy returns 503 until you add it."
    )
  if (!getOpenAIKey())
    console.warn(
      "[jm-tally] OPENAI_API_KEY / VITE_OPENAI_API_KEY not set — OpenAI /api proxy returns 503 until you add it (optional)."
    )
})
