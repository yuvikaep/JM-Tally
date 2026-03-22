import { useState, useRef, useEffect } from "react"
import styles from "./auth.module.css"
import { useAuth } from "./AuthContext.jsx"

export function ForgotPasswordPage({ onNavigate }) {
  const { sendPasswordReset, verifyOtpRequest, resetPasswordRequest } = useAuth()
  const [step, setStep] = useState(1)
  const [email, setEmail] = useState("")
  const [otp, setOtp] = useState(["", "", "", "", "", ""])
  const [pw, setPw] = useState("")
  const [pw2, setPw2] = useState("")
  const [err, setErr] = useState("")
  const [info, setInfo] = useState("")
  const [busy, setBusy] = useState(false)
  const otpRefs = useRef([])

  useEffect(() => {
    otpRefs.current = otpRefs.current.slice(0, 6)
  }, [])

  const sendOtp = async e => {
    e.preventDefault()
    setErr("")
    setInfo("")
    if (!email.trim()) {
      setErr("Please fill all required fields.")
      return
    }
    setBusy(true)
    try {
      await sendPasswordReset(email.trim())
      setInfo("OTP sent to your email.")
      setStep(2)
    } catch (x) {
      setErr(x?.message || "Request failed.")
    } finally {
      setBusy(false)
    }
  }

  const verify = async e => {
    e.preventDefault()
    setErr("")
    const code = otp.join("")
    if (code.length !== 6) {
      setErr("Please fill all required fields.")
      return
    }
    setBusy(true)
    try {
      await verifyOtpRequest(email.trim(), code)
      setStep(3)
    } catch {
      setErr("Invalid or expired OTP. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  const resetPw = async e => {
    e.preventDefault()
    setErr("")
    if (!pw || !pw2) {
      setErr("Please fill all required fields.")
      return
    }
    if (pw.length < 8) {
      setErr("Password must be at least 8 characters.")
      return
    }
    if (pw !== pw2) {
      setErr("Passwords do not match.")
      return
    }
    setBusy(true)
    try {
      await resetPasswordRequest(email.trim(), otp.join(""), pw)
      setInfo("Password updated. Please log in.")
      setTimeout(() => onNavigate("login"), 1500)
    } catch (x) {
      setErr(x?.message || "Invalid or expired OTP. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  const onOtpChange = (i, v) => {
    const d = v.replace(/\D/g, "").slice(-1)
    const next = [...otp]
    next[i] = d
    setOtp(next)
    if (d && i < 5) otpRefs.current[i + 1]?.focus()
  }

  const onOtpKeyDown = (i, e) => {
    if (e.key === "Backspace" && !otp[i] && i > 0) otpRefs.current[i - 1]?.focus()
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>Reset password</h1>
        {step === 1 ? (
          <>
            <p className={styles.subtitle}>Enter your account email. We will send a one-time code.</p>
            {err ? <p className={styles.error}>{err}</p> : null}
            <form onSubmit={sendOtp}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="fp-em">
                  Email
                </label>
                <input id="fp-em" type="email" className={styles.input} value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" />
              </div>
              <button type="submit" className={styles.btnPrimary} disabled={busy}>
                {busy ? "…" : "Send OTP"}
              </button>
            </form>
          </>
        ) : null}
        {step === 2 ? (
          <>
            {info ? <p className={styles.success}>{info}</p> : null}
            {err ? <p className={styles.error}>{err}</p> : null}
            <form onSubmit={verify}>
              <p className={styles.subtitle}>Enter the 6-digit code.</p>
              <div className={styles.otpRow}>
                {otp.map((d, i) => (
                  <input
                    key={i}
                    ref={el => {
                      otpRefs.current[i] = el
                    }}
                    type="text"
                    inputMode="numeric"
                    maxLength={1}
                    className={styles.otpBox}
                    value={d}
                    onChange={e => onOtpChange(i, e.target.value)}
                    onKeyDown={e => onOtpKeyDown(i, e)}
                    autoComplete="one-time-code"
                  />
                ))}
              </div>
              <button type="submit" className={styles.btnPrimary} disabled={busy}>
                {busy ? "…" : "Verify OTP"}
              </button>
            </form>
          </>
        ) : null}
        {step === 3 ? (
          <>
            {info ? <p className={styles.success}>{info}</p> : null}
            {err ? <p className={styles.error}>{err}</p> : null}
            <form onSubmit={resetPw}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="fp-np">
                  New password
                </label>
                <input id="fp-np" type="password" className={styles.input} value={pw} onChange={e => setPw(e.target.value)} autoComplete="new-password" />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="fp-np2">
                  Confirm password
                </label>
                <input id="fp-np2" type="password" className={styles.input} value={pw2} onChange={e => setPw2(e.target.value)} autoComplete="new-password" />
              </div>
              <button type="submit" className={styles.btnPrimary} disabled={busy}>
                {busy ? "…" : "Update password →"}
              </button>
            </form>
          </>
        ) : null}
        <div className={styles.row}>
          <button type="button" className={styles.linkMuted} onClick={() => onNavigate("login")}>
            Back to log in
          </button>
        </div>
      </div>
    </div>
  )
}
