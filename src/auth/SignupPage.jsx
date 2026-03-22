import { useState } from "react"
import styles from "./auth.module.css"
import { AuthBrandHeader } from "./AuthBrandHeader.jsx"
import { useAuth } from "./AuthContext.jsx"

const BUSINESS_TYPES = ["Sole Proprietorship", "Pvt Ltd", "Partnership/LLP", "Other"]

export function SignupPage({ onNavigate }) {
  const { signup } = useAuth()
  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [companyName, setCompanyName] = useState("")
  const [businessType, setBusinessType] = useState("")
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)

  const submit = async e => {
    e.preventDefault()
    setErr("")
    if (!firstName.trim() || !lastName.trim() || !email.trim() || !password || !companyName.trim() || !businessType) {
      setErr("Please fill all required fields.")
      return
    }
    if (password.length < 8) {
      setErr("Password must be at least 8 characters.")
      return
    }
    setBusy(true)
    try {
      await signup({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
        password,
        companyName: companyName.trim(),
        businessType,
      })
    } catch (x) {
      if (x.code === "EMAIL_EXISTS") {
        setErr("This email is already registered. Log in instead.")
      } else {
        setErr(x?.message || "Something went wrong.")
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <AuthBrandHeader />
        <div className={styles.progress}>
          <div className={`${styles.progressStep} ${styles.progressStepActive}`} />
          <div className={styles.progressStep} />
          <div className={styles.progressStep} />
        </div>
        <h1 className={styles.title}>Create account</h1>
        <p className={styles.subtitle}>Step 1 of 3 — your details and company</p>
        {err ? <p className={styles.error}>{err}</p> : null}
        <form onSubmit={submit}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="su-fn">
              First name
            </label>
            <input id="su-fn" className={styles.input} value={firstName} onChange={e => setFirstName(e.target.value)} autoComplete="given-name" />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="su-ln">
              Last name
            </label>
            <input id="su-ln" className={styles.input} value={lastName} onChange={e => setLastName(e.target.value)} autoComplete="family-name" />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="su-em">
              Work email
            </label>
            <input id="su-em" type="email" className={styles.input} value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="su-pw">
              Password
            </label>
            <input id="su-pw" type="password" className={styles.input} value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="su-co">
              Company name
            </label>
            <input id="su-co" className={styles.input} value={companyName} onChange={e => setCompanyName(e.target.value)} autoComplete="organization" />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="su-bt">
              Business type
            </label>
            <select id="su-bt" className={styles.select} value={businessType} onChange={e => setBusinessType(e.target.value)}>
              <option value="">— Select —</option>
              {BUSINESS_TYPES.map(b => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className={styles.btnPrimary} disabled={busy}>
            {busy ? "…" : "Continue"}
          </button>
        </form>
        <div className={styles.divider}>or</div>
        <button type="button" className={styles.googleBtn} disabled>
          Continue with Google
        </button>
        <div className={styles.row}>
          <span className={styles.subtitle} style={{ margin: 0 }}>
            Already have an account?
          </span>
          <button type="button" className={styles.link} onClick={() => onNavigate("login")}>
            Log in
          </button>
        </div>
      </div>
    </div>
  )
}
