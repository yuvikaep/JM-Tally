/* global process, Buffer -- Vite config runs in Node */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions'

function readAnthropicKey() {
  return String(process.env.VITE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '').trim()
}

function readOpenAIKey() {
  return String(process.env.VITE_OPENAI_API_KEY || process.env.OPENAI_API_KEY || '').trim()
}

function readOpenAIModel() {
  return String(process.env.OPENAI_CHAT_MODEL || process.env.VITE_OPENAI_CHAT_MODEL || 'gpt-4o-mini').trim()
}

/** Same handlers for `vite` and `vite preview`. */
function llmDevProxyMiddleware() {
  return (req, res, next) => {
    const p = req.url?.split('?')[0] || ''
    if (p === '/api/anthropic/v1/messages' && req.method === 'POST') {
      const key = readAnthropicKey()
      if (!key) {
        res.statusCode = 503
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(
          JSON.stringify({
            error: {
              message:
                'Set VITE_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY in .env for the dev/preview proxy.',
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
      return
    }
    if (p === '/api/openai/v1/chat/completions' && req.method === 'POST') {
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
                'No OpenAI key: paste key in the app (sent as Bearer to this proxy) or set OPENAI_API_KEY / VITE_OPENAI_API_KEY in .env.',
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
      return
    }
    next()
  }
}

function llmDevProxy() {
  return {
    name: 'llm-dev-proxy',
    configureServer(server) {
      server.middlewares.use(llmDevProxyMiddleware())
    },
    configurePreviewServer(server) {
      server.middlewares.use(llmDevProxyMiddleware())
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), llmDevProxy()],
})
