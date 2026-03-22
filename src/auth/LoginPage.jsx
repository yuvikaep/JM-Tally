import { useState } from "react"
import styles from "./auth.module.css"
import { AuthBrandHeader } from "./AuthBrandHeader.jsx"
import { useAuth } from "./AuthContext.jsx"

export function LoginPage({ onNavigate }) {
  const { login } = useAuth()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)

  const submit = async e => {
    e.preventDefault()
    setErr("")
    setBusy(true)
    try {
      await login({ email: email.trim(), password })
    } catch (x) {
      setErr(x?.message || "Incorrect email or password.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <AuthBrandHeader />
        <h1 className={styles.title}>Log in</h1>
        <p className={styles.subtitle}>Use your work email and password.</p>
        {err ? <p className={styles.error}>{err}</p> : null}
        <form onSubmit={submit}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="login-email">
              Email
            </label>
            <input id="login-email" type="email" className={styles.input} value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="login-password">
              Password
            </label>
            <input
              id="login-password"
              type="password"
              className={styles.input}
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          <button type="submit" className={styles.btnPrimary} disabled={busy}>
            {busy ? "…" : "Log in"}
          </button>
        </form>
        <div className={styles.divider}>or</div>
        <button type="button" className={styles.googleBtn} disabled>
          Continue with Google
        </button>
        <div className={styles.row}>
          <button type="button" className={styles.link} onClick={() => onNavigate("forgot")}>
            Forgot password?
          </button>
        </div>
        <div className={styles.row}>
          <span className={styles.subtitle} style={{ margin: 0 }}>
            No account?
          </span>
          <button type="button" className={styles.link} onClick={() => onNavigate("signup")}>
            Sign up
          </button>
        </div>
      </div>
    </div>
  )
}
