/* global process, Buffer -- Vite config runs in Node */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions'

function readOpenAIKey() {
  return String(process.env.VITE_OPENAI_API_KEY || process.env.OPENAI_API_KEY || '').trim()
}

function readOpenAIModel() {
  return String(process.env.OPENAI_CHAT_MODEL || process.env.VITE_OPENAI_CHAT_MODEL || 'gpt-4o-mini').trim()
}

/** Dev + preview: POST /api/openai/v1/chat/completions */
function openaiDevProxyMiddleware() {
  return (req, res, next) => {
    const p = req.url?.split('?')[0] || ''
    if (p !== '/api/openai/v1/chat/completions' || req.method !== 'POST') return next()
    const auth = String(req.headers.authorization || '')
    const fromClient = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    const key = fromClient || readOpenAIKey()
    if (!key) {
      res.statusCode = 503
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(
        JSON.stringify({
          error: {
            message:
              'No OpenAI key: paste key in the app or set OPENAI_API_KEY / VITE_OPENAI_API_KEY in .env',
          },
        })
      )
      return
    }
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', async () => {
      try {
        let body = chunks.length ? Buffer.concat(chunks).toString('utf8') : '{}'
        let parsed
        try {
          parsed = JSON.parse(body)
        } catch {
          parsed = {}
        }
        if (!parsed.model) parsed.model = readOpenAIModel()
        body = JSON.stringify(parsed)
        const r = await fetch(OPENAI_CHAT_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
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

function openaiDevProxy() {
  return {
    name: 'openai-dev-proxy',
    configureServer(server) {
      server.middlewares.use(openaiDevProxyMiddleware())
    },
    configurePreviewServer(server) {
      server.middlewares.use(openaiDevProxyMiddleware())
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), openaiDevProxy()],
})
