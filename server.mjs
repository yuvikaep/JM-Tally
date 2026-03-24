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
  if (/render\.com|amazonaws\.com|neon\.tech|supabase\.(co|com)/i.test(u)) return { rejectUnauthorized: false }
  return false
}

/** Render/Supabase pastes often include wrapping quotes — breaks pg and new URL(). */
function cleanDatabaseUrl(raw) {
  if (raw == null || raw === "") return raw
  let s = String(raw).trim()
  s = s.replace(/^["']|["']$/g, "").trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim()
  }
  return s
}

function looksLikePgUrl(s) {
  return /^postgres(ql)?:\/\//i.test(String(s || "").trim())
}

function splitPgUrlParts(rawUrl) {
  const u = String(rawUrl || "")
  const m = u.match(/^(postgres(?:ql)?):\/\/([\s\S]*)$/i)
  if (!m) return null
  const scheme = m[1]
  const rest = m[2]
  // IMPORTANT: only "/" reliably separates authority from path.
  // If the password contains "?" or "#", splitting authority on those characters prevents us from repairing it.
  const slash = rest.indexOf("/")
  const authority = slash === -1 ? rest : rest.slice(0, slash)
  const tail = slash === -1 ? "" : rest.slice(slash)
  return { scheme, authority, tail }
}

/**
 * Render env var mistakes we can automatically recover from:
 * - Wrapping quotes/newlines (handled in cleanDatabaseUrl)
 * - Password contains reserved URI characters (notably @ # ? / space)
 * Node-postgres uses WHATWG URL parsing internally and throws ERR_INVALID_URL.
 */
function repairDatabaseUrlIfNeeded(cleaned) {
  const s = String(cleaned || "").trim()
  if (!s || !looksLikePgUrl(s)) return s

  // If the platform parser accepts it, leave it alone.
  try {
    // eslint-disable-next-line no-new
    new URL(s)
    return s
  } catch {
    /* try to repair below */
  }

  const parts = splitPgUrlParts(s)
  if (!parts) return s
  const { scheme, authority, tail } = parts

  const lastAt = authority.lastIndexOf("@")
  if (lastAt === -1) return s

  const userInfo = authority.slice(0, lastAt)
  const hostPort = authority.slice(lastAt + 1)
  if (!hostPort) return s

  const colon = userInfo.indexOf(":")
  if (colon === -1) return s

  const user = userInfo.slice(0, colon)
  const pass = userInfo.slice(colon + 1)

  // Only encode when it likely contains reserved characters that break parsing.
  const needsEnc = /[@#/?\s]/.test(pass) || /[@#/?\s]/.test(user)
  if (!needsEnc) return s

  const encUser = encodeURIComponent(user)
  const encPass = encodeURIComponent(pass)
  return `${scheme}://${encUser}:${encPass}@${hostPort}${tail}`
}

/** Supabase transaction pooler (6543 / pooler host) needs pgbouncer=true for node-pg. */
function appendSupabasePoolerParam(url) {
  if (!url) return url
  const isPooler = /pooler\.supabase\.com/i.test(url) || /:6543([/?]|$)/.test(url)
  if (!isPooler || /[?&]pgbouncer=true\b/i.test(url)) return url
  try {
    const u = new URL(url)
    u.searchParams.set("pgbouncer", "true")
    return u.toString()
  } catch {
    try {
      return url.includes("?") ? `${url}&pgbouncer=true` : `${url}?pgbouncer=true`
    } catch {
      return url
    }
  }
}

function getPool() {
  if (!DATABASE_URL) return null
  if (!pool) {
    const cleaned = cleanDatabaseUrl(DATABASE_URL)
    let connStr = repairDatabaseUrlIfNeeded(cleaned)
    try {
      connStr = appendSupabasePoolerParam(connStr)
    } catch (e) {
      console.warn("appendSupabasePoolerParam:", e?.message)
    }
    try {
      pool = new Pool({
        connectionString: connStr,
        ssl: pgSslOption(),
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 20000,
      })
    } catch (e) {
      console.error(
        "Invalid DATABASE_URL for pg. In Render set DATABASE_URL to a single-line postgresql:// URI with no quotes; URL-encode special characters in the password."
      )
      throw e
    }
  }
  return pool
}

/** User-facing message for common DB / network failures (no stack traces). */
function publicErrorMessage(e) {
  const msg = String(e?.message || e || "")
  const code = e?.code
  if (code === "42P01" || /relation .* does not exist/i.test(msg)) {
    return "Database tables are not ready. Wait for deploy to finish, or run migrations in Supabase SQL editor."
  }
  if (code === "28P01" || /password authentication failed/i.test(msg)) {
    return "Database login failed. Update DATABASE_URL with the correct password from Supabase."
  }
  if (code === "3D000" || /database .* does not exist/i.test(msg)) {
    return "Database name in DATABASE_URL is wrong. Copy the connection string from Supabase again."
  }
  if (code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ENOTFOUND") {
    return "Cannot reach the database. Check DATABASE_URL and that Supabase allows your IP if required."
  }
  if (code === "23505" || /unique constraint/i.test(msg)) {
    return "This email is already registered. Log in instead."
  }
  if (/prepared statement|bind message|unsupported/i.test(msg)) {
    return "Database connection mode error. In Supabase use the Direct connection string (port 5432), not Transaction pooler, for this server."
  }
  if (process.env.DEBUG_API === "1") return msg.slice(0, 500)
  return "Something went wrong. Try again. If it persists, check Render logs."
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
  // UUIDs are always supplied in application code (no gen_random_uuid() in schema — avoids PG extension issues).
  await p.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await p.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id UUID PRIMARY KEY,
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
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      role TEXT DEFAULT 'Admin',
      UNIQUE(user_id, company_id)
    )
  `)
  await p.query(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id UUID PRIMARY KEY,
      email TEXT NOT NULL,
      otp TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN DEFAULT FALSE
    )
  `)
  console.log("Database tables ready")
}

function normalizeOrigin(s) {
  let x = String(s || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\/$/, "")
  if (x && !/^https?:\/\//i.test(x)) {
    x = `https://${x}`
  }
  return x
}

/** Comma-separated FRONTEND_URL values (optional). Used for logging / future strict mode. */
function parseAllowedOrigins() {
  const raw = (FRONTEND_URL || "*").trim()
  if (!raw || raw === "*") return ["*"]
  const out = raw.split(",").map(normalizeOrigin).filter(Boolean)
  return out.length ? out : ["*"]
}

/**
 * Browsers require Access-Control-Allow-Origin to echo the page origin exactly.
 * If FRONTEND_URL was mis-typed vs Vercel, the old allowlist logic omitted ACAO → endless CORS failures.
 * We echo Origin for any browser request; auth is still enforced by JWT on protected routes.
 */
function corsHeaders(res) {
  const req = res.__req
  const list = parseAllowedOrigins()
  const base = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  }
  if (list.includes("*")) {
    return { ...base, "Access-Control-Allow-Origin": "*" }
  }
  const origin = req?.headers?.origin
  if (origin) {
    const no = normalizeOrigin(origin)
    return { ...base, "Access-Control-Allow-Origin": no }
  }
  if (list.length) {
    return { ...base, "Access-Control-Allow-Origin": list[0] }
  }
  return base
}

function sendJson(res, status, obj) {
  if (res.headersSent) return
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(res) })
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
  res.__req = req
  const p = getPool()
  if (!p || !JWT_SECRET) {
    sendJson(res, 503, { error: "SERVICE_UNAVAILABLE", message: "Server configuration incomplete." })
    return
  }

  const method = req.method || "GET"

  if (method === "OPTIONS") {
    const h = corsHeaders(res)
    if (!h["Access-Control-Allow-Origin"]) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" })
      res.end("CORS: origin not allowed. Set FRONTEND_URL on the API to your Vercel URL (comma-separated for multiple).")
      return
    }
    res.writeHead(204, h)
    res.end()
    return
  }

  try {
    const host = req.headers.host || "localhost"
    const url = new URL(req.url || "/", `http://${host}`)
    let pathname = url.pathname
    if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1)

    if (method === "GET" && pathname === "/api/auth/health") {
      try {
        await p.query("SELECT 1")
        sendJson(res, 200, { ok: true, database: "connected" })
      } catch (he) {
        sendJson(res, 503, { ok: false, database: "error", message: publicErrorMessage(he) })
      }
      return
    }

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

    if (method === "POST" && pathname === "/api/auth/change-password") {
      const userId = await getUserIdFromAuth(req)
      if (!userId) {
        sendJson(res, 401, { error: "UNAUTHORIZED", message: "Unauthorized." })
        return
      }
      const body = await readBody(req)
      const currentPassword = String(body.currentPassword || "")
      const newPassword = String(body.newPassword || "")
      if (!currentPassword || !newPassword) {
        sendJson(res, 400, { error: "VALIDATION", message: "Please fill all required fields." })
        return
      }
      if (newPassword.length < 8) {
        sendJson(res, 400, { error: "WEAK_PASSWORD", message: "Password must be at least 8 characters." })
        return
      }
      if (newPassword === currentPassword) {
        sendJson(res, 400, { error: "VALIDATION", message: "New password must be different from current password." })
        return
      }
      const r = await p.query(`SELECT id, password_hash FROM users WHERE id = $1`, [userId])
      if (!r.rows.length) {
        sendJson(res, 401, { error: "UNAUTHORIZED", message: "Unauthorized." })
        return
      }
      const ok = await bcrypt.compare(currentPassword, r.rows[0].password_hash)
      if (!ok) {
        sendJson(res, 401, { error: "AUTH_FAILED", message: "Current password is incorrect." })
        return
      }
      const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS)
      await p.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, userId])
      sendJson(res, 200, { message: "Password changed successfully." })
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
    console.error("API handler error:", e?.code || "", e?.message || e, e?.detail || "")
    if (!res.headersSent) {
      sendJson(res, 500, {
        error: "SERVER_ERROR",
        message: publicErrorMessage(e),
        ...(process.env.DEBUG_API === "1" && e?.code ? { pgCode: e.code } : {}),
      })
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
        console.error("handleApi:", err?.code, err?.message, err)
        if (!res.headersSent) {
          res.__req = req
          sendJson(res, 500, { error: "SERVER_ERROR", message: publicErrorMessage(err) })
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

async function startServer() {
  if (DATABASE_URL) {
    let lastErr = null
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await initDb()
        lastErr = null
        break
      } catch (err) {
        lastErr = err
        console.error(`initDb attempt ${attempt}/5 failed:`, err?.code, err?.message, err?.detail || "")
        if (attempt < 5) await new Promise(r => setTimeout(r, 2500))
      }
    }
    if (lastErr) {
      console.error("FATAL: could not initialize database after 5 attempts. Fix DATABASE_URL or run SQL in Supabase.")
      process.exit(1)
    }
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`JM Tally listening on 0.0.0.0:${PORT}`)
  })
}

startServer()
