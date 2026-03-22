import { useState, useMemo } from "react"
import styles from "./auth.module.css"
import { useAuth } from "./AuthContext.jsx"
import { INDIAN_STATES_AND_UT } from "./indianStates.js"

const BUSINESS_TYPES = ["Sole Proprietorship", "Pvt Ltd", "Partnership/LLP", "Other"]

function defaultFinYear() {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth() + 1
  if (m >= 4) return `${y}-${String((y + 1) % 100).padStart(2, "0")}`
  return `${y - 1}-${String(y % 100).padStart(2, "0")}`
}

export function CompanySetupPage() {
  const { companies, updateCompanySetup, completeCompanySetupPhase } = useAuth()
  const companyId = companies[0]?.id
  const [name, setName] = useState("")
  const [gst, setGst] = useState("")
  const [state, setState] = useState("")
  const [finYear, setFinYear] = useState(defaultFinYear())
  const [currency, setCurrency] = useState("INR")
  const [businessType, setBusinessType] = useState("")
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)

  const fyOptions = useMemo(() => {
    const out = []
    const y = new Date().getFullYear()
    for (let i = -1; i <= 2; i++) {
      const a = y + i
      const b = a + 1
      const label = `${a}-${String(b % 100).padStart(2, "0")}`
      out.push(label)
    }
    return out
  }, [])

  const submit = async e => {
    e.preventDefault()
    setErr("")
    if (!companyId) {
      setErr("No company found. Contact support.")
      return
    }
    if (!name.trim()) {
      setErr("Please fill all required fields.")
      return
    }
    setBusy(true)
    try {
      await updateCompanySetup(companyId, {
        name: name.trim(),
        gst: gst.trim() || null,
        state: state || null,
        finYear,
        currency,
        businessType: businessType || null,
      })
      completeCompanySetupPhase()
    } catch (x) {
      setErr(x?.message || "Update failed.")
    } finally {
      setBusy(false)
    }
  }

  const skip = () => {
    completeCompanySetupPhase()
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.progress}>
          <div className={`${styles.progressStep} ${styles.progressStepDone}`} />
          <div className={`${styles.progressStep} ${styles.progressStepActive}`} />
          <div className={styles.progressStep} />
        </div>
        <h1 className={styles.title}>Company details</h1>
        <p className={styles.subtitle}>Step 2 of 3 — registered business information</p>
        {err ? <p className={styles.error}>{err}</p> : null}
        <form onSubmit={submit}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="cs-name">
              Company name
            </label>
            <input id="cs-name" className={styles.input} value={name} onChange={e => setName(e.target.value)} autoComplete="organization" />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="cs-gst">
              GST number (optional)
            </label>
            <input id="cs-gst" className={styles.input} value={gst} onChange={e => setGst(e.target.value.slice(0, 15))} maxLength={15} />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="cs-st">
              State / UT
            </label>
            <select id="cs-st" className={styles.select} value={state} onChange={e => setState(e.target.value)}>
              <option value="">— Select —</option>
              {INDIAN_STATES_AND_UT.map(s => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="cs-fy">
              Financial year
            </label>
            <select id="cs-fy" className={styles.select} value={finYear} onChange={e => setFinYear(e.target.value)}>
              {fyOptions.map(f => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="cs-cur">
              Currency
            </label>
            <select id="cs-cur" className={styles.select} value={currency} onChange={e => setCurrency(e.target.value)}>
              <option value="INR">INR</option>
              <option value="USD">USD</option>
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="cs-bt">
              Business type
            </label>
            <select id="cs-bt" className={styles.select} value={businessType} onChange={e => setBusinessType(e.target.value)}>
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
        <div className={styles.row}>
          <button type="button" className={styles.linkMuted} onClick={skip}>
            Skip, set up later
          </button>
        </div>
      </div>
    </div>
  )
}
