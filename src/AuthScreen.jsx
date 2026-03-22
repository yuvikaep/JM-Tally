import { useState } from "react"
import { loginUser, setSession, signupUser } from "./authStorage.js"

const pageBg = "#f0f9ff"
const card = "#ffffff"
const border = "#bae6fd"
const text = "#0c4a6e"
const muted = "#64748b"
const brand = "#6B7AFF"

const inp = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 8,
  border: `1px solid ${border}`,
  fontSize: 13,
  outline: "none",
  fontFamily: "inherit",
  boxSizing: "border-box",
}

export function AuthScreen({ baseStore, onLoggedIn }) {
  const [mode, setMode] = useState("login")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [password2, setPassword2] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")

  const submit = async e => {
    e.preventDefault()
    setErr("")
    if (mode === "signup" && password !== password2) {
      setErr("Passwords do not match.")
      return
    }
    setBusy(true)
    try {
      const res =
        mode === "signup"
          ? await signupUser(baseStore, email, password)
          : await loginUser(baseStore, email, password)
      if (!res.ok) {
        setErr(res.error || "Something went wrong.")
        return
      }
      setSession(res.user)
      onLoggedIn(res.user)
    } catch (x) {
      setErr(String(x?.message || x))
    } finally {
      setBusy(false)
    }
  }

  const tab = active => ({
    flex: 1,
    padding: "10px 12px",
    border: "none",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "inherit",
    background: active ? brand : "transparent",
    color: active ? "#fff" : muted,
  })

  return (
    <div
      style={{
        minHeight: "100vh",
        background: pageBg,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        fontFamily: "'DM Sans',system-ui,sans-serif",
      }}
    >
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700;800&display=swap');`}</style>
      <div
        style={{
          width: "100%",
          maxWidth: 400,
          background: card,
          borderRadius: 16,
          border: `1px solid ${border}`,
          boxShadow: "0 12px 40px rgba(107,122,255,.12)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "22px 22px 16px", borderBottom: `1px solid ${border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
            <img src="/logo.png" alt="" width={44} height={44} style={{ objectFit: "contain" }} />
            <div>
              <div style={{ fontSize: 18, fontWeight: 800, color: text, letterSpacing: "-0.02em" }}>JM Tally</div>
              <div style={{ fontSize: 11, color: muted, fontWeight: 600, marginTop: 2 }}>Sign in to your books</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, background: pageBg, padding: 4, borderRadius: 10 }}>
            <button type="button" style={tab(mode === "login")} onClick={() => { setMode("login"); setErr("") }}>
              Log in
            </button>
            <button type="button" style={tab(mode === "signup")} onClick={() => { setMode("signup"); setErr("") }}>
              Sign up
            </button>
          </div>
        </div>

        <form onSubmit={submit} style={{ padding: 22 }}>
          {err ? (
            <div
              style={{
                fontSize: 12,
                color: "#b91c1c",
                background: "rgba(244,63,94,.1)",
                border: "1px solid rgba(244,63,94,.3)",
                padding: "10px 12px",
                borderRadius: 8,
                marginBottom: 14,
                lineHeight: 1.45,
              }}
            >
              {err}
            </div>
          ) : null}

          <label style={{ display: "block", fontSize: 10, fontWeight: 800, color: muted, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>
            Email
          </label>
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="you@company.com"
            style={{ ...inp, marginBottom: 14 }}
            required
          />

          <label style={{ display: "block", fontSize: 10, fontWeight: 800, color: muted, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>
            Password
          </label>
          <input
            type="password"
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder={mode === "signup" ? "At least 8 characters" : "••••••••"}
            style={{ ...inp, marginBottom: mode === "signup" ? 14 : 18 }}
            required
            minLength={mode === "signup" ? 8 : undefined}
          />

          {mode === "signup" ? (
            <>
              <label style={{ display: "block", fontSize: 10, fontWeight: 800, color: muted, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>
                Confirm password
              </label>
              <input
                type="password"
                autoComplete="new-password"
                value={password2}
                onChange={e => setPassword2(e.target.value)}
                placeholder="Repeat password"
                style={{ ...inp, marginBottom: 18 }}
                required
                minLength={8}
              />
            </>
          ) : null}

          <button
            type="submit"
            disabled={busy}
            style={{
              width: "100%",
              padding: "12px 16px",
              borderRadius: 10,
              border: "none",
              background: busy ? "#94a3b8" : brand,
              color: "#fff",
              fontSize: 14,
              fontWeight: 800,
              cursor: busy ? "default" : "pointer",
              fontFamily: "inherit",
              boxShadow: busy ? "none" : "0 4px 14px rgba(107,122,255,.35)",
            }}
          >
            {busy ? "Please wait…" : mode === "signup" ? "Create account" : "Log in"}
          </button>

          <p style={{ fontSize: 10.5, color: muted, lineHeight: 1.55, marginTop: 16, marginBottom: 0 }}>
            Accounts and sessions are stored in this browser (localStorage + session). Logging out clears the session; use another browser or device for a separate account. This is not cloud sync.
          </p>
        </form>
      </div>
    </div>
  )
}
