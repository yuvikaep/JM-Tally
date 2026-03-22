/**
 * Production static server for Render (and similar). Serves dist/ + SPA fallback.
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

function safeFileFromUrlPath(urlPath) {
  const clean = String(urlPath || "").replace(/^\/+/, "")
  const parts = clean.split("/").filter(p => p && p !== "." && p !== "..")
  if (parts.length === 0) return path.join(rootResolved, "index.html")
  const full = path.resolve(rootResolved, ...parts)
  const rel = path.relative(rootResolved, full)
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null
  return full
}

const rootResolved = path.resolve(root)

const server = http.createServer((req, res) => {
  try {
    const host = req.headers.host || "localhost"
    const url = new URL(req.url || "/", `http://${host}`)
    let pathname = decodeURIComponent(url.pathname)
    const filePath = pathname === "/" ? path.join(rootResolved, "index.html") : safeFileFromUrlPath(pathname)
    if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
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
    res.end(html)
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" })
    res.end(String(e?.message || e))
  }
})

server.listen(PORT, "0.0.0.0", () => {
  console.log(`JM Tally listening on 0.0.0.0:${PORT}`)
})
