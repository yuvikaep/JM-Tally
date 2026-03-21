/* global process, Buffer -- Vite config runs in Node */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'

/** Same handler for `vite` and `vite preview` (preview used to return 405 for POST /api/*). */
function anthropicProxyMiddleware() {
  return (req, res, next) => {
    const p = req.url?.split('?')[0] || ''
    if (p !== '/api/anthropic/v1/messages' || req.method !== 'POST') return next()
    const key = String(process.env.VITE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '').trim()
    if (!key) {
      res.statusCode = 503
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(
        JSON.stringify({
          error: {
            message:
              'Set VITE_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY in .env for the dev/preview proxy (key stays server-side).',
          },
        })
      )
      return
    }
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', async () => {
      try {
        const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : '{}'
        const r = await fetch(ANTHROPIC_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
          },
          body,
        })
        const txt = await r.text()
        res.statusCode = r.status
        res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json; charset=utf-8')
        res.end(txt)
      } catch (e) {
        res.statusCode = 502
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: { message: String(e?.message || e) } }))
      }
    })
  }
}

function anthropicDevProxy() {
  return {
    name: 'anthropic-dev-proxy',
    configureServer(server) {
      server.middlewares.use(anthropicProxyMiddleware())
    },
    configurePreviewServer(server) {
      server.middlewares.use(anthropicProxyMiddleware())
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), anthropicDevProxy()],
})
