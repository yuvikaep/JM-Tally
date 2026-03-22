/**
 * Local auth: accounts in base storage (shared key), session in sessionStorage.
 * Books data lives in per-user scoped storage — see createScopedStore.
 */

export const AUTH_USERS_KEY = "jm_auth_users_v1"
const SESSION_KEY = "jm_auth_session_v1"

function randomId() {
  return "usr_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10)
}

function u8ToB64(u8) {
  let s = ""
  u8.forEach(b => (s += String.fromCharCode(b)))
  return btoa(s)
}

function b64ToU8(b64) {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

async function pbkdf2Hash(password, saltB64) {
  const enc = new TextEncoder()
  const salt = b64ToU8(saltB64)
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"])
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 120_000, hash: "SHA-256" },
    keyMaterial,
    256
  )
  return u8ToB64(new Uint8Array(bits))
}

async function newPasswordRecord(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const saltB64 = u8ToB64(salt)
  const hashB64 = await pbkdf2Hash(password, saltB64)
  return { saltB64, hashB64 }
}

async function verifyPassword(password, saltB64, hashB64) {
  const h = await pbkdf2Hash(password, saltB64)
  if (h.length !== hashB64.length) return false
  let ok = 0
  for (let i = 0; i < h.length; i++) ok |= h.charCodeAt(i) ^ hashB64.charCodeAt(i)
  return ok === 0
}

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase()
}

export function getSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const o = JSON.parse(raw)
    if (!o?.userId || !o?.email) return null
    return { id: o.userId, email: String(o.email) }
  } catch {
    return null
  }
}

export function setSession(user) {
  if (!user?.id || !user?.email) return
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ userId: user.id, email: user.email }))
}

export function clearSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY)
  } catch {
    /* ignore */
  }
}

async function readAccounts(baseStore) {
  const doc = (await baseStore.get(AUTH_USERS_KEY)) || { version: 1, users: [] }
  return { version: 1, users: Array.isArray(doc.users) ? doc.users : [] }
}

async function writeAccounts(baseStore, doc) {
  await baseStore.set(AUTH_USERS_KEY, doc)
}

/**
 * Wrap storage so each user has isolated keys (prefix). Pass the same base store used for auth accounts.
 */
export function createScopedStore(userId, baseStore) {
  const prefix = `jm_uid_${userId}_`
  return {
    async get(k) {
      return baseStore.get(prefix + k)
    },
    async set(k, v) {
      return baseStore.set(prefix + k, v)
    },
    async remove(k) {
      return baseStore.remove(prefix + k)
    },
  }
}

/**
 * @returns {{ ok: true, user: { id, email } } | { ok: false, error: string }}
 */
export async function signupUser(baseStore, emailRaw, password) {
  const email = normalizeEmail(emailRaw)
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "Enter a valid email address." }
  }
  if (String(password || "").length < 8) {
    return { ok: false, error: "Password must be at least 8 characters." }
  }
  if (!crypto?.subtle) {
    return { ok: false, error: "This browser does not support secure sign-up (Web Crypto)." }
  }

  const doc = await readAccounts(baseStore)
  if (doc.users.some(u => normalizeEmail(u.email) === email)) {
    return { ok: false, error: "An account with this email already exists. Try logging in." }
  }

  const { saltB64, hashB64 } = await newPasswordRecord(password)
  const user = {
    id: randomId(),
    email,
    saltB64,
    hashB64,
    createdAt: new Date().toISOString(),
  }
  doc.users.push(user)
  await writeAccounts(baseStore, doc)
  return { ok: true, user: { id: user.id, email: user.email } }
}

/**
 * @returns {{ ok: true, user: { id, email } } | { ok: false, error: string }}
 */
export async function loginUser(baseStore, emailRaw, password) {
  const email = normalizeEmail(emailRaw)
  if (!email || !password) {
    return { ok: false, error: "Enter email and password." }
  }
  if (!crypto?.subtle) {
    return { ok: false, error: "This browser does not support login (Web Crypto)." }
  }

  const doc = await readAccounts(baseStore)
  const user = doc.users.find(u => normalizeEmail(u.email) === email)
  if (!user) {
    return { ok: false, error: "No account found for this email." }
  }
  const ok = await verifyPassword(password, user.saltB64, user.hashB64)
  if (!ok) {
    return { ok: false, error: "Wrong password." }
  }
  return { ok: true, user: { id: user.id, email: user.email } }
}
