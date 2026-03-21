/**
 * Vercel Serverless — POST /api/openai/v1/chat/completions
 * Bearer from client (browser key) or OPENAI_API_KEY / VITE_OPENAI_API_KEY on Vercel.
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
  const auth = String(req.headers.authorization || "")
  const fromClient = auth.startsWith("Bearer ") ? auth.slice(7).trim() : ""
  const key =
    fromClient ||
    String(process.env.OPENAI_API_KEY || process.env.VITE_OPENAI_API_KEY || "").trim()
  if (!key) {
    res
      .status(503)
      .setHeader("Content-Type", "application/json")
      .json({
        error: {
          message:
            "No OpenAI key: set OPENAI_API_KEY on Vercel, or paste a key in the app (sent as Bearer to this function).",
        },
      })
    return
  }
  let parsed = req.body
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      parsed = {}
    }
  }
  if (!parsed || typeof parsed !== "object") parsed = {}
  if (!parsed.model)
    parsed.model = String(process.env.OPENAI_CHAT_MODEL || process.env.VITE_OPENAI_CHAT_MODEL || "gpt-4o-mini").trim()
  const body = JSON.stringify(parsed)
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body,
    })
    const txt = await r.text()
    res.status(r.status).setHeader("Content-Type", r.headers.get("content-type") || "application/json").send(txt)
  } catch (e) {
    res.status(502).setHeader("Content-Type", "application/json").json({ error: { message: String(e?.message || e) } })
  }
}
