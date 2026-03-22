/**
 * User-configurable automation: optional match rules + quick-post templates.
 * Categorisation presets ship disabled — enable only what you want.
 */

import { enrichTxnJournal } from "./accountingEngine.js"

/** Preset rows (all categorise rules default to enabled: false). */
export const DEFAULT_AUTOMATION_SKILLS = [
  {
    id: "auto_naukri",
    enabled: false,
    kind: "categorize",
    label: "Naukri → Recruitment",
    match: "naukri",
    category: "Recruitment - Job Portals",
    onlyMisc: false,
  },
  {
    id: "auto_linkedin",
    enabled: false,
    kind: "categorize",
    label: "LinkedIn → Recruitment",
    match: "linkedin",
    category: "Recruitment - Job Portals",
    onlyMisc: false,
  },
  {
    id: "auto_indeed",
    enabled: false,
    kind: "categorize",
    label: "Indeed → Recruitment",
    match: "indeed",
    category: "Recruitment - Job Portals",
    onlyMisc: false,
  },
  {
    id: "auto_razorpay",
    enabled: false,
    kind: "categorize",
    label: "Razorpay → Payment gateway",
    match: "razorpay",
    category: "Payment Gateway",
    onlyMisc: true,
  },
  {
    id: "auto_stripe",
    enabled: false,
    kind: "categorize",
    label: "Stripe → Payment gateway",
    match: "stripe",
    category: "Payment Gateway",
    onlyMisc: true,
  },
  {
    id: "auto_aws",
    enabled: false,
    kind: "categorize",
    label: "AWS / Amazon Web → Vendor IT",
    match: "amazon web services",
    category: "Vendor - IT Solutions",
    onlyMisc: true,
  },
  {
    id: "tpl_rent",
    enabled: true,
    kind: "template",
    label: "Post office rent (edit amount first)",
    particulars: "Office rent",
    amount: 25000,
    drCr: "DR",
    category: "Rent Expense",
  },
  {
    id: "tpl_salary",
    enabled: true,
    kind: "template",
    label: "Post salary batch placeholder",
    particulars: "Salary transfer",
    amount: 100000,
    drCr: "DR",
    category: "Salary",
  },
]

export function newCustomSkillId() {
  return "c_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7)
}

/** Merge saved skills into defaults (by id); append unknown ids as custom. */
export function coerceAutomationSkills(raw, defaults = DEFAULT_AUTOMATION_SKILLS) {
  const saved = Array.isArray(raw) ? raw : []
  const byId = Object.fromEntries(saved.map(s => [s.id, s]))
  const merged = defaults.map(d => {
    const o = byId[d.id]
    if (!o) return { ...d }
    return {
      ...d,
      ...o,
      kind: d.kind,
      id: d.id,
    }
  })
  const defaultIds = new Set(defaults.map(d => d.id))
  const extras = saved.filter(s => s && s.id && !defaultIds.has(s.id))
  return [...merged, ...extras]
}

export function isValidCategorizeSkill(s, allowedCategories) {
  if (!s || s.kind !== "categorize") return false
  if (!String(s.match || "").trim()) return false
  if (!allowedCategories.includes(s.category)) return false
  return true
}

export function isValidTemplateSkill(s, allowedCategories) {
  if (!s || s.kind !== "template") return false
  if (!String(s.label || "").trim()) return false
  if (!String(s.particulars || "").trim()) return false
  const a = Number(s.amount)
  if (!Number.isFinite(a) || a <= 0) return false
  if (s.drCr !== "DR" && s.drCr !== "CR") return false
  if (!allowedCategories.includes(s.category)) return false
  return true
}

/**
 * Apply enabled categorization skills (first match wins, in array order).
 * Rebuilds journal lines when category changes.
 */
export function applyCategorizationSkills(txns, skills, { allowedCategories }) {
  if (!Array.isArray(txns) || !txns.length) return { txns, changed: 0 }
  const rules = (skills || []).filter(
    s => s && s.enabled && s.kind === "categorize" && isValidCategorizeSkill(s, allowedCategories)
  )
  if (!rules.length) return { txns, changed: 0 }

  let changed = 0
  const out = txns.map(t => {
    if (t.void) return t
    const hay = `${t.particulars || ""} ${t.bankRemark || ""}`.toLowerCase()
    for (const s of rules) {
      const needle = String(s.match).toLowerCase().trim()
      if (!needle || !hay.includes(needle)) continue
      const onlyMisc = s.onlyMisc !== false
      if (onlyMisc && t.category !== "Misc Expense" && t.category !== "Misc Income") break
      if (t.category === s.category) break
      changed++
      const next = { ...t, category: s.category }
      delete next.journalLines
      return enrichTxnJournal(next)
    }
    return t
  })

  return { txns: out, changed }
}
