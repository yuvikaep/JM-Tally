/**
 * Vercel Serverless — same path as app fetch: POST /api/anthropic/v1/messages
 * Set ANTHROPIC_API_KEY (preferred) or VITE_ANTHROPIC_API_KEY in Vercel → Environment.
 * Avoid putting secrets in VITE_* if you only need server-side chat; use ANTHROPIC_API_KEY only.
 */
export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.status(204).end()
    return
  }
  if (req.method !== "POST") {
    res.status(405).setHeader("Content-Type", "application/json").json({ error: { message: "Method not allowed" } })
    return
  }
  const key = String(process.env.ANTHROPIC_API_KEY || process.env.VITE_ANTHROPIC_API_KEY || "").trim()
  if (!key) {
    res
      .status(503)
      .setHeader("Content-Type", "application/json")
      .json({
        error: {
          message:
            "ANTHROPIC_API_KEY not set on Vercel. Add it under Project → Settings → Environment Variables (not exposed to client).",
        },
      })
    return
  }
  const body =
    typeof req.body === "string" ? req.body : req.body != null ? JSON.stringify(req.body) : "{}"
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body,
    })
    const txt = await r.text()
    res.status(r.status).setHeader("Content-Type", r.headers.get("content-type") || "application/json").send(txt)
  } catch (e) {
    res.status(502).setHeader("Content-Type", "application/json").json({ error: { message: String(e?.message || e) } })
  }
}
