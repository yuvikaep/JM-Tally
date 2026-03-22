/**
 * Static server + auth API (Render). Uses Node http only + pg + JWT + bcrypt.
 */
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"
import pg from "pg"
import jwt from "jsonwebtoken"
import bcrypt from "bcryptjs"

const { Pool } = pg

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, "dist")
const PORT = Number(process.env.PORT) || 4173
const DATABASE_URL = process.env.DATABASE_URL
const JWT_SECRET = process.env.JWT_SECRET || ""
const FRONTEND_URL = process.env.FRONTEND_URL || "*"
const NODE_ENV = process.env.NODE_ENV || "development"

const BCRYPT_ROUNDS = 12
const JWT_EXPIRES = "30d"
const OTP_EXPIRES_MIN = 10

let pool = null

function pgSslOption() {
  if (NODE_ENV === "production") return { rejectUnauthorized: false }
  const u = DATABASE_URL || ""
  if (/render\.com|amazonaws\.com|neon\.tech|supabase\.co/i.test(u)) return { rejectUnauthorized: false }
  return false
}

function getPool() {
  if (!DATABASE_URL) return null
  if (!pool) {
    pool = new Pool({ connectionString: DATABASE_URL, ssl: pgSslOption() })
  }
  return pool
}

/** Pool.query() uses arbitrary connections — BEGIN/COMMIT must use one client. */
async function withTransaction(poolInstance, fn) {
  const client = await poolInstance.connect()
  try {
    await client.query("BEGIN")
    await fn(client)
    await client.query("COMMIT")
  } catch (e) {
    try {
      await client.query("ROLLBACK")
    } catch (rbErr) {
      console.error("ROLLBACK failed:", rbErr)
    }
    throw e
  } finally {
    client.release()
  }
}

async function initDb() {
  const p = getPool()
  if (!p) {
    console.warn("DATABASE_URL not set — API routes disabled")
    return
  }
  await p.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`)
  await p.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await p.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      business_type TEXT,
      gst TEXT,
      state TEXT,
      fin_year TEXT,
      currency TEXT DEFAULT 'INR',
      plan TEXT DEFAULT 'free',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await p.query(`
    CREATE TABLE IF NOT EXISTS user_companies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      role TEXT DEFAULT 'Admin',
      UNIQUE(user_id, company_id)
    )
  `)
  await p.query(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL,
      otp TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN DEFAULT FALSE
    )
  `)
  console.log("Database tables ready")
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": FRONTEND_URL === "*" ? "*" : FRONTEND_URL,
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  }
}

function sendJson(res, status, obj) {
  if (res.headersSent) return
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() })
  res.end(JSON.stringify(obj))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on("data", c => chunks.push(c))
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8")
        if (!raw) return resolve({})
        resolve(JSON.parse(raw))
      } catch (e) {
        reject(e)
      }
    })
    req.on("error", reject)
  })
}

function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES })
}

function verifyToken(token) {
  try {
    if (!JWT_SECRET) return null
    const p = jwt.verify(token, JWT_SECRET)
    return p?.userId || null
  } catch {
    return null
  }
}

async function getUserIdFromAuth(req) {
  const h = req.headers.authorization || ""
  const m = /^Bearer\s+(.+)$/i.exec(h)
  if (!m) return null
  return verifyToken(m[1].trim())
}

function rowUser(r) {
  return {
    id: r.id,
    email: r.email,
    firstName: r.first_name,
    lastName: r.last_name,
    createdAt: r.created_at,
  }
}

function rowCompany(r) {
  return {
    id: r.id,
    name: r.name,
    businessType: r.business_type,
    gst: r.gst,
    state: r.state,
    finYear: r.fin_year,
    currency: r.currency,
    plan: r.plan,
    createdAt: r.created_at,
  }
}

async function assertCompanyAccess(p, userId, companyId) {
  const r = await p.query(
    `SELECT role FROM user_companies WHERE user_id = $1 AND company_id = $2`,
    [userId, companyId]
  )
  return r.rows[0] || null
}

async function handleApi(req, res) {
  const p = getPool()
  if (!p || !JWT_SECRET) {
    sendJson(res, 503, { error: "SERVICE_UNAVAILABLE", message: "Server configuration incomplete." })
    return
  }

  const method = req.method || "GET"

  if (method === "OPTIONS") {
    res.writeHead(204, corsHeaders())
    res.end()
    return
  }

  try {
    const host = req.headers.host || "localhost"
    const url = new URL(req.url || "/", `http://${host}`)
    let pathname = url.pathname
    if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1)
    if (method === "POST" && pathname === "/api/auth/signup") {
      const body = await readBody(req)
      const firstName = String(body.firstName || "").trim()
      const lastName = String(body.lastName || "").trim()
      const email = String(body.email || "").trim().toLowerCase()
      const password = String(body.password || "")
      const companyName = String(body.companyName || "").trim()
      const businessType = String(body.businessType || "").trim()
      if (!firstName || !lastName || !email || !password || !companyName || !businessType) {
        sendJson(res, 400, { error: "VALIDATION", message: "Please fill all required fields." })
        return
      }
      if (password.length < 8) {
        sendJson(res, 400, { error: "WEAK_PASSWORD", message: "Password must be at least 8 characters." })
        return
      }
      const exists = await p.query(`SELECT id FROM users WHERE email = $1`, [email])
      if (exists.rows.length) {
        sendJson(res, 409, { error: "EMAIL_EXISTS", message: "This email is already registered. Log in instead." })
        return
      }
      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)
      const uid = crypto.randomUUID()
      const cid = crypto.randomUUID()
      const uc = crypto.randomUUID()
      await withTransaction(p, async client => {
        await client.query(
          `INSERT INTO users (id, first_name, last_name, email, password_hash) VALUES ($1,$2,$3,$4,$5)`,
          [uid, firstName, lastName, email, passwordHash]
        )
        await client.query(
          `INSERT INTO companies (id, name, business_type, currency, plan, fin_year) VALUES ($1,$2,$3,'INR','free',$4)`,
          [cid, companyName, businessType, defaultFinYear()]
        )
        await client.query(`INSERT INTO user_companies (id, user_id, company_id, role) VALUES ($1,$2,$3,'Admin')`, [uc, uid, cid])
      })
      const token = signToken(uid)
      const urow = (await p.query(`SELECT id, email, first_name, last_name, created_at FROM users WHERE id = $1`, [uid])).rows[0]
      sendJson(res, 201, { token, user: rowUser(urow), company: rowCompany((await p.query(`SELECT * FROM companies WHERE id = $1`, [cid])).rows[0]) })
      return
    }

    if (method === "POST" && pathname === "/api/auth/login") {
      const body = await readBody(req)
      const email = String(body.email || "").trim().toLowerCase()
      const password = String(body.password || "")
      if (!email || !password) {
        sendJson(res, 400, { error: "VALIDATION", message: "Please fill all required fields." })
        return
      }
      const r = await p.query(`SELECT * FROM users WHERE email = $1`, [email])
      if (!r.rows.length) {
        sendJson(res, 401, { error: "AUTH_FAILED", message: "Incorrect email or password." })
        return
      }
      const u = r.rows[0]
      const ok = await bcrypt.compare(password, u.password_hash)
      if (!ok) {
        sendJson(res, 401, { error: "AUTH_FAILED", message: "Incorrect email or password." })
        return
      }
      const token = signToken(u.id)
      sendJson(res, 200, { token, user: rowUser(u) })
      return
    }

    if (method === "GET" && pathname === "/api/auth/me") {
      const userId = await getUserIdFromAuth(req)
      if (!userId) {
        sendJson(res, 401, { error: "UNAUTHORIZED", message: "Unauthorized." })
        return
      }
      const r = await p.query(`SELECT id, email, first_name, last_name, created_at FROM users WHERE id = $1`, [userId])
      if (!r.rows.length) {
        sendJson(res, 401, { error: "UNAUTHORIZED", message: "Unauthorized." })
        return
      }
      sendJson(res, 200, { user: rowUser(r.rows[0]) })
      return
    }

    if (method === "GET" && pathname === "/api/auth/companies") {
      const userId = await getUserIdFromAuth(req)
      if (!userId) {
        sendJson(res, 401, { error: "UNAUTHORIZED", message: "Unauthorized." })
        return
      }
      const r = await p.query(
        `SELECT c.*, uc.role FROM companies c
         INNER JOIN user_companies uc ON uc.company_id = c.id
         WHERE uc.user_id = $1 ORDER BY c.created_at ASC`,
        [userId]
      )
      sendJson(
        res,
        200,
        {
          companies: r.rows.map(row => ({
            ...rowCompany(row),
            role: row.role,
          })),
        }
      )
      return
    }

    if (method === "POST" && pathname === "/api/auth/companies") {
      const userId = await getUserIdFromAuth(req)
      if (!userId) {
        sendJson(res, 401, { error: "UNAUTHORIZED", message: "Unauthorized." })
        return
      }
      const body = await readBody(req)
      const name = String(body.name || "").trim()
      if (!name) {
        sendJson(res, 400, { error: "VALIDATION", message: "Company name is required." })
        return
      }
      const cid = crypto.randomUUID()
      const ucid = crypto.randomUUID()
      await p.query(
        `INSERT INTO companies (id, name, business_type, gst, state, fin_year, currency, plan) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          cid,
          name,
          body.businessType || null,
          body.gst || null,
          body.state || null,
          body.finYear || defaultFinYear(),
          body.currency || "INR",
          body.plan || "free",
        ]
      )
      await p.query(`INSERT INTO user_companies (id, user_id, company_id, role) VALUES ($1,$2,$3,'Admin')`, [ucid, userId, cid])
      const row = (await p.query(`SELECT * FROM companies WHERE id = $1`, [cid])).rows[0]
      sendJson(res, 201, { company: { ...rowCompany(row), role: "Admin" } })
      return
    }

    if (method === "PUT" && pathname.startsWith("/api/auth/companies/")) {
      const userId = await getUserIdFromAuth(req)
      if (!userId) {
        sendJson(res, 401, { error: "UNAUTHORIZED", message: "Unauthorized." })
        return
      }
      const companyId = pathname.replace("/api/auth/companies/", "").split("/")[0]
      if (!companyId || !/^[0-9a-f-]{36}$/i.test(companyId)) {
        sendJson(res, 400, { error: "VALIDATION", message: "Invalid company." })
        return
      }
      const access = await assertCompanyAccess(p, userId, companyId)
      if (!access) {
        sendJson(res, 403, { error: "FORBIDDEN", message: "Forbidden." })
        return
      }
      const body = await readBody(req)
      const fields = []
      const vals = []
      let i = 1
      if (body.name != null) {
        fields.push(`name = $${i++}`)
        vals.push(String(body.name).trim())
      }
      if (body.businessType != null) {
        fields.push(`business_type = $${i++}`)
        vals.push(body.businessType)
      }
      if (body.gst != null) {
        fields.push(`gst = $${i++}`)
        vals.push(String(body.gst).trim().slice(0, 15))
      }
      if (body.state != null) {
        fields.push(`state = $${i++}`)
        vals.push(body.state)
      }
      if (body.finYear != null) {
        fields.push(`fin_year = $${i++}`)
        vals.push(body.finYear)
      }
      if (body.currency != null) {
        fields.push(`currency = $${i++}`)
        vals.push(body.currency)
      }
      if (body.plan != null) {
        fields.push(`plan = $${i++}`)
        vals.push(body.plan)
      }
      if (!fields.length) {
        sendJson(res, 400, { error: "VALIDATION", message: "No fields to update." })
        return
      }
      vals.push(companyId)
      await p.query(`UPDATE companies SET ${fields.join(", ")} WHERE id = $${i}`, vals)
      const row = (await p.query(`SELECT * FROM companies WHERE id = $1`, [companyId])).rows[0]
      sendJson(res, 200, { company: rowCompany(row) })
      return
    }

    if (method === "POST" && pathname === "/api/auth/forgot-password") {
      const body = await readBody(req)
      const email = String(body.email || "").trim().toLowerCase()
      if (!email) {
        sendJson(res, 400, { error: "VALIDATION", message: "Please enter your email." })
        return
      }
      const r = await p.query(`SELECT id FROM users WHERE email = $1`, [email])
      const otp = String(Math.floor(100000 + Math.random() * 900000))
      const expires = new Date(Date.now() + OTP_EXPIRES_MIN * 60 * 1000)
      if (r.rows.length) {
        await p.query(`INSERT INTO password_resets (id, email, otp, expires_at, used) VALUES ($1,$2,$3,$4,false)`, [
          crypto.randomUUID(),
          email,
          otp,
          expires,
        ])
        console.log(`[password-reset] email=${email} otp=${otp} expires=${expires.toISOString()}`)
      }
      sendJson(res, 200, { message: "OTP sent to your email." })
      return
    }

    if (method === "POST" && pathname === "/api/auth/verify-otp") {
      const body = await readBody(req)
      const email = String(body.email || "").trim().toLowerCase()
      const otp = String(body.otp || "").trim()
      if (!email || !otp) {
        sendJson(res, 400, { error: "VALIDATION", message: "Please fill all required fields." })
        return
      }
      const r = await p.query(
        `SELECT id FROM password_resets WHERE email = $1 AND otp = $2 AND used = false AND expires_at > NOW() ORDER BY expires_at DESC LIMIT 1`,
        [email, otp]
      )
      if (!r.rows.length) {
        sendJson(res, 400, { error: "INVALID_OTP", message: "Invalid or expired OTP. Please try again." })
        return
      }
      sendJson(res, 200, { ok: true })
      return
    }

    if (method === "POST" && pathname === "/api/auth/reset-password") {
      const body = await readBody(req)
      const email = String(body.email || "").trim().toLowerCase()
      const otp = String(body.otp || "").trim()
      const newPassword = String(body.newPassword || "")
      if (!email || !otp || !newPassword) {
        sendJson(res, 400, { error: "VALIDATION", message: "Please fill all required fields." })
        return
      }
      if (newPassword.length < 8) {
        sendJson(res, 400, { error: "WEAK_PASSWORD", message: "Password must be at least 8 characters." })
        return
      }
      const r = await p.query(
        `SELECT id FROM password_resets WHERE email = $1 AND otp = $2 AND used = false AND expires_at > NOW() ORDER BY expires_at DESC LIMIT 1`,
        [email, otp]
      )
      if (!r.rows.length) {
        sendJson(res, 400, { error: "INVALID_OTP", message: "Invalid or expired OTP. Please try again." })
        return
      }
      const prId = r.rows[0].id
      const u = await p.query(`SELECT id FROM users WHERE email = $1`, [email])
      if (!u.rows.length) {
        sendJson(res, 400, { error: "INVALID_OTP", message: "Invalid or expired OTP. Please try again." })
        return
      }
      const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS)
      await withTransaction(p, async client => {
        await client.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, u.rows[0].id])
        await client.query(`UPDATE password_resets SET used = true WHERE id = $1`, [prId])
      })
      sendJson(res, 200, { message: "Password updated. Please log in." })
      return
    }

    sendJson(res, 404, { error: "NOT_FOUND", message: "Not found." })
  } catch (e) {
    console.error(e)
    if (!res.headersSent) {
      sendJson(res, 500, { error: "SERVER_ERROR", message: "Something went wrong." })
    }
  }
}

function defaultFinYear() {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth() + 1
  if (m >= 4) return `${y}-${String((y + 1) % 100).padStart(2, "0")}`
  return `${y - 1}-${String(y % 100).padStart(2, "0")}`
}

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

function safeFileFromUrlPath(urlPath, rootResolved) {
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

    if (pathname.startsWith("/api/")) {
      handleApi(req, res).catch(err => {
        console.error("handleApi:", err)
        if (!res.headersSent) {
          sendJson(res, 500, { error: "SERVER_ERROR", message: "Something went wrong." })
        }
      })
      return
    }

    const filePath = pathname === "/" ? path.join(rootResolved, "index.html") : safeFileFromUrlPath(pathname, rootResolved)
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

initDb()
  .catch(err => {
    console.error("DB init failed:", err)
  })
  .finally(() => {
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`JM Tally listening on 0.0.0.0:${PORT}`)
    })
  })
