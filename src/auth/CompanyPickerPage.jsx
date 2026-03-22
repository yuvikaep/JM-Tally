import { useState, useEffect } from "react"
import styles from "./auth.module.css"
import { useAuth } from "./AuthContext.jsx"

function initials(name) {
  const p = String(name || "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
  if (!p.length) return "?"
  return p.map(x => x[0]).join("").toUpperCase()
}

function strColor(s) {
  let h = 0
  const str = String(s || "x")
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360
  return `hsl(${h} 48% 40%)`
}

export function CompanyPickerPage() {
  const { companies, activeCompany, setActiveCompany, addCompany, refreshCompanies, logout } = useAuth()
  const [selectedId, setSelectedId] = useState(() => activeCompany?.id || "")
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState("")
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!companies.length) return
    setSelectedId(prev => {
      if (prev && companies.some(c => c.id === prev)) return prev
      return companies[0].id
    })
  }, [companies])

  const openWorkspace = () => {
    setErr("")
    const c = companies.find(x => x.id === selectedId)
    if (!c) {
      setErr("Select a company.")
      return
    }
    setActiveCompany(c)
  }

  const createNew = async e => {
    e.preventDefault()
    setErr("")
    if (!newName.trim()) {
      setErr("Please fill all required fields.")
      return
    }
    setBusy(true)
    try {
      const data = await addCompany({ name: newName.trim() })
      if (data?.company?.id) setSelectedId(data.company.id)
      setNewName("")
      setAdding(false)
      await refreshCompanies()
    } catch (x) {
      setErr(x?.message || "Could not add company.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.page}>
      <div className={`${styles.card} ${styles.pickerList}`} style={{ maxWidth: 520 }}>
        <h1 className={styles.title}>Your companies</h1>
        <p className={styles.subtitle}>Select a workspace to open the dashboard.</p>
        {err ? <p className={styles.error}>{err}</p> : null}
        {companies.length === 0 ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon} aria-hidden>
              📂
            </div>
            <p className={styles.title} style={{ fontSize: "1.05rem", marginBottom: 8 }}>
              No companies yet
            </p>
            {!adding ? (
              <button type="button" className={styles.btnPrimary} onClick={() => setAdding(true)}>
                Add your first company
              </button>
            ) : null}
          </div>
        ) : (
          companies.map(c => (
            <button
              key={c.id}
              type="button"
              className={`${styles.companyRow} ${selectedId === c.id ? styles.companyRowSelected : ""}`}
              onClick={() => setSelectedId(c.id)}
            >
              <div className={styles.avatar} style={{ background: strColor(c.id) }}>
                {initials(c.name)}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, color: "#0c4a6e", fontSize: "0.9375rem" }}>{c.name}</div>
                <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
                  {c.role || "Admin"} · {c.plan || "free"} · FY {c.finYear || "—"}
                </div>
              </div>
            </button>
          ))
        )}
        {adding ? (
          <form onSubmit={createNew} style={{ marginBottom: 12 }}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="np-co">
                Company name
              </label>
              <input id="np-co" className={styles.input} value={newName} onChange={e => setNewName(e.target.value)} />
            </div>
            <button type="submit" className={styles.btnPrimary} disabled={busy}>
              {busy ? "…" : "Create company"}
            </button>
            <button type="button" className={styles.linkMuted} style={{ marginTop: 8 }} onClick={() => { setAdding(false); setNewName("") }}>
              Cancel
            </button>
          </form>
        ) : companies.length > 0 ? (
          <button type="button" className={styles.addDashed} onClick={() => setAdding(true)}>
            + Add new company
          </button>
        ) : null}
        <button type="button" className={styles.btnAccent} onClick={openWorkspace} disabled={!companies.length || !selectedId}>
          Open workspace →
        </button>
        <div className={styles.row}>
          <button type="button" className={styles.linkMuted} onClick={logout}>
            Switch account
          </button>
        </div>
      </div>
    </div>
  )
}
