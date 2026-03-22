const BASE = (import.meta.env.VITE_API_URL || "")
  .trim()
  .replace(/\/$/, "")
  .replace(/\/api$/i, "")
const TOKEN_KEY = "jmtally_token"

export function getStoredToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || ""
  } catch {
    return ""
  }
}

function setStoredToken(t) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

async function request(path, { method = "GET", body, auth = false } = {}) {
  const headers = { "Content-Type": "application/json" }
  if (auth) {
    const tok = getStoredToken()
    if (tok) headers.Authorization = `Bearer ${tok}`
  }
  const url = `${BASE}${path}`
  const res = await fetch(url, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { message: text || "Request failed" }
  }
  if (!res.ok) {
    const err = new Error(data.message || data.error || `HTTP ${res.status}`)
    err.code = data.error
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

export function setToken(token) {
  setStoredToken(token)
}

export function clearToken() {
  setStoredToken("")
}

export async function signup(payload) {
  const data = await request("/api/auth/signup", { method: "POST", body: payload })
  if (data.token) setStoredToken(data.token)
  return data
}

export async function login(payload) {
  const data = await request("/api/auth/login", { method: "POST", body: payload })
  if (data.token) setStoredToken(data.token)
  return data
}

export async function getMe() {
  return request("/api/auth/me", { auth: true })
}

export async function getCompanies() {
  return request("/api/auth/companies", { auth: true })
}

export async function createCompany(payload) {
  return request("/api/auth/companies", { method: "POST", body: payload, auth: true })
}

export async function updateCompany(companyId, payload) {
  return request(`/api/auth/companies/${companyId}`, { method: "PUT", body: payload, auth: true })
}

export async function forgotPassword(payload) {
  return request("/api/auth/forgot-password", { method: "POST", body: payload })
}

export async function verifyOtp(payload) {
  return request("/api/auth/verify-otp", { method: "POST", body: payload })
}

export async function resetPassword(payload) {
  return request("/api/auth/reset-password", { method: "POST", body: payload })
}
