import { useState } from "react"
import styles from "./auth.module.css"
import { useAuth } from "./AuthContext.jsx"

const PLANS = [
  { id: "starter", name: "Starter", price: "₹0/mo", feats: "50 transactions/month · 1 user" },
  { id: "business", name: "Business", price: "₹499/mo", feats: "Unlimited transactions · GST filing · 3 users", popular: true },
  { id: "multi_company", name: "Multi-company", price: "₹999/mo", feats: "Up to 5 companies · 10 users" },
]

export function PlanSelectionPage() {
  const { companies, applyPlan } = useAuth()
  const companyId = companies[0]?.id
  const [selected, setSelected] = useState("")
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)

  const ctaLabel = () => {
    if (selected === "starter") return "Start for free →"
    if (selected === "business") return "Pay ₹499/month via Razorpay →"
    if (selected === "multi_company") return "Pay ₹999/month via Razorpay →"
    return "Choose a plan"
  }

  const confirm = async () => {
    setErr("")
    if (!selected || !companyId) {
      setErr("Please select a plan.")
      return
    }
    setBusy(true)
    try {
      await applyPlan(companyId, selected)
    } catch (x) {
      setErr(x?.message || "Could not save plan.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card} style={{ maxWidth: 520 }}>
        <div className={styles.progress}>
          <div className={`${styles.progressStep} ${styles.progressStepDone}`} />
          <div className={`${styles.progressStep} ${styles.progressStepDone}`} />
          <div className={`${styles.progressStep} ${styles.progressStepActive}`} />
        </div>
        <h1 className={styles.title}>Choose a plan</h1>
        <p className={styles.subtitle}>Step 3 of 3 — pick what fits your business</p>
        {err ? <p className={styles.error}>{err}</p> : null}
        <div className={styles.planGrid}>
          {PLANS.map(p => (
            <button
              key={p.id}
              type="button"
              className={`${styles.planCard} ${selected === p.id ? styles.planCardSelected : ""}`}
              onClick={() => setSelected(p.id)}
            >
              {p.popular ? <span className={styles.badge}>Popular</span> : null}
              <div className={styles.planName}>{p.name}</div>
              <div className={styles.planPrice}>{p.price}</div>
              <p className={styles.planFeat}>{p.feats}</p>
            </button>
          ))}
        </div>
        <button type="button" className={styles.btnAccent} disabled={!selected || busy} onClick={confirm}>
          {busy ? "…" : ctaLabel()}
        </button>
        <p className={styles.note}>Paid plans via Razorpay · secure checkout</p>
      </div>
    </div>
  )
}
