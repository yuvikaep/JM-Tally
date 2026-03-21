import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import {
  buildJournalLines,
  validateBalanced,
  withRecalculatedBalances,
  isDuplicateTxn,
  isPeriodLocked,
  parseDdMmYyyy,
  enrichTxnJournal,
  CHART_OF_ACCOUNTS,
  categoryToNominalAccount,
  stripBalancesAfter,
  aggregateMonthlyCashflow,
  aggregateByCategory,
  trialBalanceFromJournal,
  coaRowsWithBalances,
  estimatedTotalOutputGst,
  filterTxnsForReport,
  fyToMonthOptions,
  distinctFYs,
  inferFY,
  draftInvoiceSettlementTxns,
} from "./accountingEngine.js"
import { bankFileToImportMatrix, importBankStatementFromMatrix } from "./bankStatementImport.js"
import {
  STORAGE_EPOCH,
  bootstrapCompanies,
  readRegistry,
  writeRegistry,
  loadCompanyPayload,
  persistCompanyPayload,
  appendCompanyAudit,
  removeCompanyData,
  newCompanyId,
} from "./companyStorage.js"

/** Light UI surfaces — sky blue & white */
const SKY = {
  page: "#f0f9ff",
  surface: "#ffffff",
  surface2: "#e0f2fe",
  surface3: "#bae6fd",
  border: "#bae6fd",
  borderHi: "#7dd3fc",
  text: "#0c4a6e",
  text2: "#0369a1",
  muted: "#64748b",
  muted2: "#475569",
  hover: "#f0f9ff",
  rowLine: "#e0f2fe",
  shadow: "0 8px 30px rgba(107,122,255,.14)",
}

/** JM Tally — brand blue from logo (#6B7AFF) */
const JM = {
  p: "#6B7AFF",
  p2: "#5563E8",
  soft: "#6B7AFF",
  ink: "#6B7AFF",
  gradient: "linear-gradient(135deg,#8B9AFF,#6B7AFF)",
  cardTint: "linear-gradient(135deg,rgba(107,122,255,.12),#ffffff)",
  r: a => `rgba(107,122,255,${a})`,
}

const CATS = [
  "Revenue - B2B Services",
  "Revenue - SaaS / Subscriptions",
  "Revenue - Marketplace",
  "Revenue - Professional Fees",
  "Revenue - Other",
  "Director Payment",
  "Salary",
  "Rent Expense",
  "Recruitment - Job Portals",
  "Vendor - Supplies",
  "Vendor - IT Solutions",
  "Vendor - Professional",
  "Vendor - Other",
  "Capital Infusion - Director",
  "Capital Infusion - Cash",
  "Bank Charges",
  "Income Tax Refund",
  "NEFT Return",
  "Misc Expense",
  "Misc Income",
  "Payment Gateway",
]
const REVENUE_CATS = CATS.filter(c => c.startsWith("Revenue"))
const LEGACY_CATEGORY_MAP = {
  "Revenue - Credhast": "Revenue - B2B Services",
  "Revenue - WheelsEye": "Revenue - B2B Services",
  "Revenue - YellowPedal": "Revenue - B2B Services",
  "Revenue - TruckSup": "Revenue - B2B Services",
  "Revenue - ValueDrive": "Revenue - B2B Services",
  "Revenue - Shiprocket": "Revenue - B2B Services",
  "Revenue - Swapecos": "Revenue - B2B Services",
  "Revenue - PureRide": "Revenue - B2B Services",
  "Revenue - Levante": "Revenue - B2B Services",
  "Vendor - Consulta": "Vendor - Professional",
  "Vendor - Preserve": "Vendor - Supplies",
}

/** Bank narration hints for Naukri, Apna, WorkIndia, JobHai, LinkedIn, etc. */
const JOB_PORTAL_HINT_RE = /naukri|jobhai|work\s*india|workindia|apna\.co|apna\.jobs|apna\s+jobs?|indeed|linkedin|\bshine\b|monster|foundit|hirist|instahyre|glassdoor|iimjobs|cutshort|wellfound|babajob|jobportal|job[\s\/._-]*portal|hiring[\s\/._-]*portal|timesjobs?|freshersworld|headhonchos|placement\s*portal|recruitment\s*portal|simplyhired|ziprecruiter|careerbuilder|seek\.com|naukri\.com|workindia\.com|jobhai\.com/i

/** NEFT/IMPS to IT Solutions (Jana SFB etc.) — book as vendor IT expense, not salary/misc */
const IT_SOLUTIONS_VENDOR_RE = /\bIT\s+SOLUTIONS\b/i

/** Bulk salary rows sometimes posted as Misc Expense in bank extract */
const AGGREGATE_SALARY_MISC_RE = /Salary payments|Staff salary payments|Staff salary\s*\+\s*misc|multiple staff|\d+\+\s*payees/i

/** Bundled vendor + small misc (single bank debit) */
const VENDOR_MISC_AGG_RE = /Multiple vendor|vendor\s*\/\s*misc/i

const normalizeTxnCategories = arr =>
  arr.map(t => {
    const mapped = LEGACY_CATEGORY_MAP[t.category]
    let u = mapped ? { ...t, category: mapped } : { ...t }
    u = u.category === "Salary - Field Staff" ? { ...u, category: "Salary" } : u
    if (u.drCr === "DR" && IT_SOLUTIONS_VENDOR_RE.test(u.particulars || ""))
      u = { ...u, category: "Vendor - IT Solutions" }
    else if (
      u.category === "Salary - Shilpi Kori" ||
      (u.drCr === "DR" && /\bShilpi\s+Kori\b/i.test(u.particulars || ""))
    )
      u = { ...u, category: "Salary" }
    else if (u.category === "Director Payment" && JOB_PORTAL_HINT_RE.test(u.particulars || ""))
      u = { ...u, category: "Recruitment - Job Portals" }
    else if (u.drCr === "DR" && u.category === "Misc Expense" && AGGREGATE_SALARY_MISC_RE.test(u.particulars || ""))
      u = { ...u, category: "Salary" }
    else if (u.drCr === "DR" && u.category === "Misc Expense" && VENDOR_MISC_AGG_RE.test(u.particulars || ""))
      u = { ...u, category: "Vendor - Other" }
    return u
  })

// Storage (localStorage; CreateOS `window.storage` supported when present)
const store = {
  async get(k) {
    try {
      if (typeof window !== "undefined" && window.storage?.get) {
        const r = await window.storage.get(k)
        return r?.value ? JSON.parse(r.value) : null
      }
      const r = localStorage.getItem(k)
      return r ? JSON.parse(r) : null
    } catch {
      return null
    }
  },
  async set(k, v) {
    try {
      if (typeof window !== "undefined" && window.storage?.set) {
        await window.storage.set(k, JSON.stringify(v))
        return
      }
      localStorage.setItem(k, JSON.stringify(v))
    } catch {}
  },
  async remove(k) {
    try {
      if (typeof window !== "undefined" && window.storage?.remove) {
        await window.storage.remove(k)
        return
      }
      localStorage.removeItem(k)
    } catch {}
  },
}

// Helpers
const inr = v => new Intl.NumberFormat("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2}).format(v||0)
const inr0 = v => new Intl.NumberFormat("en-IN",{maximumFractionDigits:0}).format(v||0)
const today = () => { const d=new Date(); return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}` }
const todayISO = () => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}` }
const addDaysISO = (iso, days) => {
  const d = new Date((iso || todayISO()) + "T12:00:00")
  d.setDate(d.getDate() + (Number(days) || 0))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}
/** Taxable + GST breakdown; place `intra` = CGST+SGST, `inter` = IGST */
const computeInvoiceGst = (taxable, ratePct, place) => {
  const t = Math.round((parseFloat(String(taxable).replace(/,/g, "")) || 0) * 100) / 100
  const r = parseFloat(ratePct) || 0
  if (!t) return { cgst: 0, sgst: 0, igst: 0, gst: 0, total: 0 }
  if (!r) return { cgst: 0, sgst: 0, igst: 0, gst: 0, total: t }
  const gst = Math.round(t * (r / 100) * 100) / 100
  if (place === "inter") return { cgst: 0, sgst: 0, igst: gst, gst, total: Math.round((t + gst) * 100) / 100 }
  const half = Math.round((gst / 2) * 100) / 100
  const sgst = Math.round((gst - half) * 100) / 100
  return { cgst: half, sgst, igst: 0, gst, total: Math.round((t + gst) * 100) / 100 }
}

function normalizeInvoiceRow(inv) {
  if (!inv || typeof inv !== "object") return inv
  const t = Number(inv.taxable) || 0
  const g = Number(inv.gst_rate) || 0
  const place = inv.place === "inter" ? "inter" : "intra"
  let cgst = Number(inv.cgst) || 0
  let sgst = Number(inv.sgst) || 0
  let igst = Number(inv.igst) || 0
  let total = Number(inv.total) || 0
  if (!total && t) {
    const b = computeInvoiceGst(t, g, place)
    cgst = b.cgst
    sgst = b.sgst
    igst = b.igst
    total = b.total
  }
  const cap = total || Number.POSITIVE_INFINITY
  const paidAmount = Math.min(Number(inv.paidAmount) || 0, cap)
  let paidBankTotal = Number(inv.paidBankTotal)
  let paidTdsTotal = Number(inv.paidTdsTotal)
  if (!Number.isFinite(paidBankTotal)) paidBankTotal = paidAmount
  if (!Number.isFinite(paidTdsTotal)) paidTdsTotal = 0
  paidBankTotal = Math.max(0, Math.min(paidBankTotal, cap))
  paidTdsTotal = Math.max(0, Math.min(paidTdsTotal, cap))
  return {
    id: inv.id,
    num: String(inv.num || ""),
    date: inv.date || todayISO(),
    dueDate: inv.dueDate || inv.date || todayISO(),
    client: String(inv.client || ""),
    gstin: String(inv.gstin || ""),
    sac: String(inv.sac || "998314"),
    taxable: t,
    gst_rate: g,
    cgst,
    sgst,
    igst,
    total,
    desc: String(inv.desc || ""),
    place,
    revenueCategory: inv.revenueCategory || REVENUE_CATS[0] || "Revenue - B2B Services",
    notes: String(inv.notes || ""),
    status: inv.status || "sent",
    paidAmount: Math.min(paidAmount, cap),
    paidBankTotal,
    paidTdsTotal,
    paidAt: inv.paidAt || "",
    createdAt: inv.createdAt || new Date().toISOString(),
  }
}

function suggestNextInvoiceNum(list) {
  let max = 0
  for (const inv of list || []) {
    const parts = String(inv.num || "").match(/\d+/g)
    if (parts) for (const x of parts) max = Math.max(max, parseInt(x, 10))
  }
  return `INV-${String(max + 1).padStart(4, "0")}`
}

function invoiceBalance(inv) {
  const tot = Number(inv.total) || 0
  const paid = Number(inv.paidAmount) || 0
  return Math.round((tot - paid) * 100) / 100
}

function invoiceUiStatus(inv) {
  const bal = invoiceBalance(inv)
  if (bal <= 0.01) return "paid"
  if ((Number(inv.paidAmount) || 0) > 0) return "partial"
  const due = new Date((inv.dueDate || inv.date) + "T23:59:59")
  if (due < new Date()) return "overdue"
  return inv.status === "draft" ? "draft" : "sent"
}

const isoToDdMmYyyy = iso => {
  if (!iso || typeof iso !== "string") return today()
  if (iso.includes("/")) return iso
  const [y, m, day] = iso.split("-")
  if (!y || !m || !day) return today()
  return `${String(day).padStart(2,"0")}/${String(m).padStart(2,"0")}/${y}`
}

/** Compact FY for UI: stored value `2024-25` → `FY24-25` */
const formatFyLabel = canonical => {
  if (!canonical || typeof canonical !== "string") return ""
  const p = canonical.split("-")
  if (p.length !== 2) return canonical
  const y1 = String(Number(p[0])).slice(-2)
  const y2 = String(Number(p[1])).padStart(2, "0")
  return `FY${y1}-${y2}`
}

/** GST @18% inclusive (CGST+SGST) — for vendor payments shown as gross in bank */
const gst18InclusiveSplit = gross => {
  const taxable = Math.round((gross / 1.18) * 100) / 100
  const gst = Math.round((gross - taxable) * 100) / 100
  const cgst = Math.round((gst / 2) * 100) / 100
  const sgst = Math.round((gst - cgst) * 100) / 100
  return { taxable, gst, cgst, sgst }
}

const catColor = cat => {
  if(!cat) return "#64748b"
  if(cat.startsWith("Revenue")) return "#10b981"
  if(cat.includes("Recruitment")) return "#ec4899"
  if(cat.includes("Rent")) return "#f97316"
  if(cat.includes("Director")) return "#f43f5e"
  if(cat.includes("Salary")) return "#f59e0b"
  if (cat.includes("Vendor")) return "#5563E8"
  if (cat.includes("Capital")) return JM.p
  if(cat.includes("Tax Refund")) return "#06b6d4"
  return "#64748b"
}

const pillStyle = (cat, label) => {
  const c = catColor(cat||label||"")
  const bg = c+"26"
  return {background:bg, color:c, border:`1px solid ${c}44`, padding:"2px 8px", borderRadius:20, fontSize:10, fontWeight:700, whiteSpace:"nowrap", display:"inline-block"}
}

// Components
function Chip({cat, label}) {
  return <span style={pillStyle(cat, label)}>{label||cat}</span>
}

function Stat({ label, value, sub, color, icon }) {
  return (
    <div style={{ background: SKY.surface, border: `1px solid ${SKY.border}`, borderRadius: 12, padding: "14px 16px", boxShadow: "0 1px 3px rgba(107,122,255,.08)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: SKY.muted, textTransform: "uppercase", letterSpacing: ".5px" }}>{label}</div>
        {icon && <span style={{ fontSize: 14 }}>{icon}</span>}
      </div>
      <div style={{ fontSize: 20, fontWeight: 800, color: color || SKY.text, letterSpacing: -1, fontFamily: "monospace" }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: SKY.muted, marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

function Tbl({ cols, rows, empty = "No records" }) {
  return (
    <div style={{ overflowX: "auto", borderRadius: 8, border: `1px solid ${SKY.border}`, background: SKY.surface }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ background: SKY.surface2 }}>
            {cols.map((c, i) => (
              <th key={i} style={{ padding: "8px 11px", textAlign: c.r ? "right" : "left", fontSize: 10, fontWeight: 700, color: SKY.text2, borderBottom: `1px solid ${SKY.borderHi}`, whiteSpace: "nowrap", textTransform: "uppercase", letterSpacing: ".3px" }}>
                {c.h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={cols.length} style={{ padding: 28, textAlign: "center", color: SKY.muted2 }}>
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((r, i) => (
              <tr
                key={i}
                onMouseEnter={e => (e.currentTarget.style.background = SKY.hover)}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                style={{ borderBottom: `1px solid ${SKY.rowLine}`, transition: "background .1s" }}
              >
                {cols.map((c, j) => (
                  <td key={j} style={{ padding: "7px 11px", textAlign: c.r ? "right" : "left", color: c.mono ? SKY.text : SKY.muted, fontFamily: c.mono ? "monospace" : "inherit" }}>
                    {c.cell ? c.cell(r) : r[c.k]}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

function Modal({ open, title, onClose, onSave, saveDisabled, saveLabel, children }) {
  if (!open) return null
  return (
    <div onClick={e => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, background: "rgba(12,74,110,.35)", backdropFilter: "blur(4px)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: SKY.surface, border: `1px solid ${SKY.borderHi}`, borderRadius: 16, width: 560, maxWidth: "94vw", maxHeight: "88vh", overflowY: "auto", boxShadow: SKY.shadow }}>
        <div style={{ padding: "15px 20px", borderBottom: `1px solid ${SKY.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: SKY.text }}>{title}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: SKY.muted, fontSize: 16, padding: "4px 8px" }}>
            ✕
          </button>
        </div>
        <div style={{ padding: 20 }}>{children}</div>
        <div style={{ padding: "12px 20px", borderTop: `1px solid ${SKY.border}`, display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={{ background: "transparent", border: `1px solid ${SKY.borderHi}`, borderRadius: 8, padding: "6px 14px", fontSize: 12, fontWeight: 600, color: SKY.text2, cursor: "pointer" }}>
            Cancel
          </button>
          <button type="button" onClick={onSave} disabled={saveDisabled} style={{ background: saveDisabled ? SKY.border : JM.p, border: "none", borderRadius: 8, padding: "6px 16px", fontSize: 12, fontWeight: 700, color: "#fff", cursor: saveDisabled ? "default" : "pointer", opacity: saveDisabled ? 0.85 : 1 }}>
            {saveLabel || "Save Entry"}
          </button>
        </div>
      </div>
    </div>
  )
}

const IS = {
  background: SKY.surface,
  border: `1px solid ${SKY.borderHi}`,
  borderRadius: 8,
  padding: "8px 11px",
  fontSize: 12,
  color: SKY.text,
  outline: "none",
  width: "100%",
  fontFamily: "inherit",
}
const LB = { fontSize: 10, fontWeight: 700, color: SKY.muted, display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: ".5px" }
function F({label, children}) { return <div style={{marginBottom:12}}><label style={LB}>{label}</label>{children}</div> }

/** User-supplied OpenAI key (this browser only) when the host has no server proxy. */
const OPENAI_KEY_LS = "jm_tally_openai_key"

function readOpenAIKeyFromLS() {
  try {
    if (typeof localStorage === "undefined") return ""
    const v = localStorage.getItem(OPENAI_KEY_LS)
    return v != null ? String(v).trim() : ""
  } catch {
    return ""
  }
}

/** Order: local override → runtime injection (server.mjs) → Vite build-time env */
function getOpenAIApiKey() {
  const ls = readOpenAIKeyFromLS()
  if (ls) return ls
  if (typeof window !== "undefined" && window.__JM_TALLY_CONFIG__?.openaiApiKey != null) {
    const k = String(window.__JM_TALLY_CONFIG__.openaiApiKey).trim()
    if (k) return k
  }
  const v = import.meta.env.VITE_OPENAI_API_KEY
  return typeof v === "string" ? v.trim() : ""
}

function apiPathPrefix() {
  const base = import.meta.env.BASE_URL || "/"
  return base === "/" ? "" : base.replace(/\/$/, "")
}

function openaiProxyUrl() {
  return `${apiPathPrefix()}/api/openai/v1/chat/completions`
}

function openaiChatModel() {
  const m = import.meta.env.VITE_OPENAI_CHAT_MODEL
  return typeof m === "string" && m.trim() ? m.trim() : "gpt-4o-mini"
}

function toOpenAIChatMessages(system, messages) {
  const out = []
  if (system) out.push({ role: "system", content: system })
  for (const m of messages) {
    const role = m.role === "assistant" ? "assistant" : "user"
    const content =
      typeof m.content === "string" ? m.content : JSON.stringify(m.content != null ? m.content : "")
    out.push({ role, content })
  }
  return out
}

/** OpenAI: same-origin proxy only (CORS). Optional Bearer from localStorage / injected key. */
async function fetchOpenAIChatMessages({ system, messages, max_tokens = 800 }) {
  const payload = {
    model: openaiChatModel(),
    max_tokens,
    messages: toOpenAIChatMessages(system, messages),
  }
  const sk = getOpenAIApiKey()
  const headers = { "Content-Type": "application/json" }
  if (sk) headers.Authorization = `Bearer ${sk}`
  const res = await fetch(openaiProxyUrl(), {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 404 || res.status === 503 || res.status === 405)
      throw new Error("no_key")
    const em = String(data.error?.message || "")
    const code = data.error?.code || data.error?.type || ""
    if (
      /incorrect api key|invalid_api_key|invalid api key/i.test(em) ||
      /invalid_api_key|invalid_request_error/i.test(String(code))
    )
      throw new Error("bad_openai_key")
    throw new Error(em || `OpenAI API ${res.status}`)
  }
  const text = data.choices?.[0]?.message?.content
  if (typeof text !== "string")
    throw new Error(data.error?.message || "OpenAI: empty response")
  return { content: [{ text }], _provider: "openai" }
}

function hasOpenAiKeyHint() {
  return !!getOpenAIApiKey()
}

function buildChatSystemPrompt(co, snap) {
  const org = String(co?.legalName || co?.name || "your company").replace(/</g, "")
  const bank = String(co?.bankAccountLabel || "operating bank — set label in Companies").replace(/</g, "")
  const s = snap || {}
  const recent = String(s.recentLines || "").trim()
  const recentBlock =
    recent.length > 3200 ? `${recent.slice(0, 3200)}…` : recent || "—"
  return `You are the AI accounting assistant inside JM Tally for ${org} (${bank}).

REAL FINANCIALS (live ledger in this browser): Approx. bank balance ₹${inr0(s.balance ?? 0)} | ${s.count ?? 0} transactions | Top revenue line: ${String(s.topRevName || "—").slice(0, 80)} · ₹${inr0(s.topRevAmt ?? 0)} | Salary (DR): ₹${inr0(s.salaryDr ?? 0)} | Output GST (est.): ₹${inr0(s.gstEst ?? 0)} | IT refund (CR): ₹${inr0(s.itRefund ?? 0)}

RECENT LEDGER LINES (newest last; each line is date · Dr/Cr · amount · category · particulars). **Particulars** may include **Remarks:** when the bank statement had a separate Remarks column — use that text the same as narration for meaning (UTR, invoice #, payee, purpose). Suggest reclassification only when substance clearly differs from current category.
${recentBlock}

CLASSIFICATION: Bank debits to job / hiring portals (Naukri, Apna, WorkIndia, JobHai, LinkedIn, Indeed, Shine, Monster, Foundit, etc.) are **Recruitment - Job Portals**, not Director Payment—unless the narration is clearly director remuneration.

INDIAN TAX: GST 18% SAC 998314 (typical IT services) CGST+SGST. GSTR-1 by 11th, GSTR-3B by 20th. TDS Sec 192 salary slab, 194J professional 10%, 194C contractor 1-2%, 194I rent 10%. PF ≥20 employees 12%+13%. ESI ≤₹21k 0.75%+3.25%. New regime slabs: 0-3L=0%, 3-7L=5%, 7-10L=10%, 10-12L=15%, 12-15L=20%, >15L=30%.

ACCOUNTING ENGINE (mandatory): **Double-entry** — every bank line maps to a balanced journal (min 2 legs, ΣDr=ΣCr). Receipt: Dr Bank, Cr income/equity nominal. Payment: Dr expense nominal, Cr Bank. **Golden rules**: Real a/c (debit what comes in); Personal (debit receiver, credit giver); Nominal (debit expense/loss, credit income/gain). **Accrual-minded**: classify by substance. **No hard delete** — only **void** (audit trail). Integrators: POST JSON like \`{ date, entries:[{account,type:"debit"|"credit",amount}] }\` with balanced lines.

When user says paid/received/rent/Amazon purchase, extract amount/desc/type. Format with **bold** for numbers. Be concise.

POSTING DRAFT (optional — the app never saves until the user confirms on the card):
When the user clearly intends to record one or more bank lines and amounts + nature are unambiguous, end with a single final plain line (not a markdown code block):
JM_TALLY_POST:[{"particulars":"short narration","amount":50000,"drCr":"DR","category":"Rent Expense"}]
Use a one-element array for a single payment/receipt; multiple objects only when the user explicitly described separate bank movements in the same message.
Optional per object: "date":"YYYY-MM-DD" when they gave a specific day.
- drCr: "DR" = money out of bank (payments/expenses); "CR" = money into bank (receipts/income).
- category must be exactly one of: ${CATS.join(" | ")}.
- amount: JSON number in rupees (no commas).
For pure Q&A or ambiguous amounts, omit JM_TALLY_POST and ask a short clarifying question. Never claim an entry was already posted.`
}

function normalizeChatEntry(obj) {
  if (!obj || typeof obj !== "object") return null
  const amt = Number(obj.amount)
  const particulars = String(obj.particulars || obj.desc || "").trim()
  const drRaw = String(obj.drCr || obj.type || "")
    .trim()
    .toUpperCase()
  const type =
    drRaw === "CR" || drRaw === "CREDIT" ? "CR" : drRaw === "DR" || drRaw === "DEBIT" ? "DR" : null
  let cat = null
  const cIn = String(obj.category || "").trim()
  if (cIn) {
    cat = CATS.find(c => c === cIn) || CATS.find(c => c.toLowerCase() === cIn.toLowerCase()) || null
    if (!cat) {
      const low = cIn.toLowerCase()
      cat =
        CATS.find(c => c.toLowerCase().includes(low) || low.includes(c.toLowerCase().split(" - ")[0] || "")) ||
        null
    }
  }
  if (!cat) cat = type === "CR" ? "Misc Income" : "Misc Expense"
  let dateIso = null
  const ds = obj.date != null ? String(obj.date).trim() : ""
  if (/^\d{4}-\d{2}-\d{2}/.test(ds)) dateIso = ds.slice(0, 10)
  if (Number.isFinite(amt) && amt > 0 && particulars.length > 0 && type)
    return { amt, desc: particulars, type, cat, dateIso }
  return null
}

/** Strip AI footer JM_TALLY_POST:… and return normalized draft lines for the confirm card. */
function parseChatPostFooter(raw) {
  if (!raw || typeof raw !== "string") return { text: String(raw || "").trim(), entries: [] }
  const marker = "JM_TALLY_POST:"
  const idx = raw.lastIndexOf(marker)
  if (idx < 0) return { text: raw.trim(), entries: [] }
  const jsonStr = raw.slice(idx + marker.length).trim()
  let entries = []
  try {
    const parsed = JSON.parse(jsonStr)
    const list = Array.isArray(parsed) ? parsed : [parsed]
    entries = list.map(normalizeChatEntry).filter(Boolean)
  } catch {
    return { text: raw.trim(), entries: [] }
  }
  let text = (idx > 0 ? raw.slice(0, idx) : "").trim()
  if (!text && entries.length)
    text =
      "From our chat, here's what I'd record — **edit if needed and confirm below** (or **Skip**)."
  return { text, entries }
}

/** Chat → suggested posting (double-entry applied on save via engine). */
function maybeQueueChatConfirm(msg, setMsgs) {
  const rent =
    msg.match(/paid?\s*(?:rs\.?|₹)?\s*([\d,]+)\s*(?:for\s*)?rent/i) ||
    msg.match(/\b([\d,]+)\s*(?:rs\.?|rupees|₹)?\s*(?:kiraya\s+)?rent\s*(?:diya|diya hai|pay|paid|de)?/i) ||
    msg.match(/rent\s*(?:of)?\s*(?:rs\.?|₹)?\s*([\d,]+)/i)
  const amz =
    msg.match(/(?:amazon|flipkart)\s*(?:se|pe|par)?\s*(?:rs\.?|₹)?\s*([\d,]+)/i) ||
    msg.match(/\b([\d,]+)\s*(?:rs|rupees|₹)?\s*(?:for\s*)?(?:amazon|flipkart)/i) ||
    msg.match(/(?:saman|खरीद|kharid).{0,40}?(?:rs\.?|₹)?\s*([\d,]+)/i)
  const pm = msg.match(/paid?\s*(?:rs\.?|₹)?\s*([\d,]+)\s*for\s*([\w\s]+)/i)
  const rcm = msg.match(/received?\s*(?:rs\.?|₹)?\s*([\d,]+)\s*from\s*([\w\s]+)/i)
  let amt
  let desc
  let type
  let cat
  if (rent) {
    amt = parseFloat(rent[1].replace(/,/g, ""))
    desc = "Rent payment"
    type = "DR"
    cat = "Rent Expense"
  } else if (amz) {
    amt = parseFloat(amz[1].replace(/,/g, ""))
    desc = /flipkart/i.test(msg) ? "Purchase — Flipkart" : "Purchase — Amazon / supplies"
    type = "DR"
    cat = "Vendor - Other"
  } else if (pm || rcm) {
    amt = parseFloat((pm || rcm)[1].replace(/,/g, ""))
    const rm = msg.match(/paid?\s*(?:rs\.?|₹)?\s*([\d,]+)\s*(?:for\s*)?rent/i)
    desc = rm ? "Rent Payment" : pm ? "Payment for " + pm[2].trim() : "Revenue from " + rcm[2].trim()
    type = rcm ? "CR" : "DR"
    cat = rm ? "Rent Expense" : rcm ? "Misc Income" : "Misc Expense"
  }
  if (amt > 0 && desc && type && cat)
    setTimeout(
      () =>
        setMsgs(p => [
          ...p,
          {
            role: "confirm",
            confirmId: `r-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            entries: [{ amt, desc, type, cat, dateIso: null }],
          },
        ]),
      400
    )
}

function ChatConfirmCard({ acctRole, initialEntries, onAddBatch, onDismiss }) {
  const [lines, setLines] = useState(() =>
    initialEntries.map(e => ({
      particulars: e.desc,
      amount: String(e.amt),
      drCr: e.type === "CR" ? "CR" : "DR",
      category: e.cat,
      date: e.dateIso && /^\d{4}-\d{2}-\d{2}$/.test(e.dateIso) ? e.dateIso : todayISO(),
    }))
  )
  const inputRow = { marginBottom: 10, paddingBottom: 10, borderBottom: `1px solid ${SKY.rowLine}` }
  const removeLine = idx => {
    if (lines.length <= 1) return
    setLines(prev => prev.filter((_, i) => i !== idx))
  }
  const updateLine = (idx, patch) => {
    setLines(prev => prev.map((L, i) => (i === idx ? { ...L, ...patch } : L)))
  }
  const sum = lines.reduce((s, L) => s + (parseFloat(String(L.amount).replace(/,/g, "")) || 0), 0)
  return (
    <div
      style={{
        background: "#ffffff",
        border: "1px solid #bae6fd",
        borderRadius: 10,
        padding: 12,
        maxWidth: "min(640px, 94%)",
        alignSelf: "flex-start",
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 700, color: "#0c4a6e", marginBottom: 8 }}>Review before adding</div>
      <div style={{ fontSize: 10, color: "#64748b", marginBottom: 10 }}>
        Edit fields if needed, then add to your books (nothing is saved until you confirm).
      </div>
      {lines.map((L, idx) => (
        <div key={idx} style={inputRow}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: SKY.muted }}>Line {idx + 1}</span>
            {lines.length > 1 && (
              <button
                type="button"
                onClick={() => removeLine(idx)}
                style={{
                  fontSize: 10,
                  border: "none",
                  background: "transparent",
                  color: "#f43f5e",
                  cursor: "pointer",
                }}
              >
                Remove
              </button>
            )}
          </div>
          <div style={{ marginBottom: 8 }}>
            <label style={LB}>Description</label>
            <input
              style={IS}
              value={L.particulars}
              onChange={e => updateLine(idx, { particulars: e.target.value })}
            />
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 100px" }}>
              <label style={LB}>Amount (₹)</label>
              <input
                style={IS}
                inputMode="decimal"
                value={L.amount}
                onChange={e => updateLine(idx, { amount: e.target.value })}
              />
            </div>
            <div style={{ flex: "0 0 108px" }}>
              <label style={LB}>Bank</label>
              <select style={IS} value={L.drCr} onChange={e => updateLine(idx, { drCr: e.target.value })}>
                <option value="DR">Debit (paid)</option>
                <option value="CR">Credit (rcvd)</option>
              </select>
            </div>
            <div style={{ flex: "1 1 130px" }}>
              <label style={LB}>Date</label>
              <input
                type="date"
                style={IS}
                value={L.date}
                onChange={e => updateLine(idx, { date: e.target.value })}
              />
            </div>
          </div>
          <div style={{ marginTop: 8 }}>
            <label style={LB}>Category</label>
            <select style={IS} value={L.category} onChange={e => updateLine(idx, { category: e.target.value })}>
              {CATS.map(c => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </div>
      ))}
      <div style={{ fontSize: 11, fontWeight: 600, color: "#0c4a6e", marginTop: 4, marginBottom: 10 }}>
        Total ₹{inr(sum)}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button
          type="button"
          disabled={acctRole === "Viewer"}
          onClick={() =>
            onAddBatch(
              lines.map(L => ({
                particulars: L.particulars.trim(),
                amount: L.amount,
                drCr: L.drCr,
                category: L.category,
                date: L.date,
              }))
            )
          }
          style={{
            background: acctRole === "Viewer" ? "#bae6fd" : "#10b981",
            border: "none",
            borderRadius: 7,
            padding: "5px 11px",
            fontSize: 11,
            fontWeight: 700,
            color: "#fff",
            cursor: acctRole === "Viewer" ? "default" : "pointer",
          }}
        >
          {acctRole === "Viewer" ? "View-only" : lines.length > 1 ? "✓ Add all to books" : "✓ Add to books"}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          style={{
            background: "transparent",
            border: "1px solid #bae6fd",
            borderRadius: 7,
            padding: "5px 11px",
            fontSize: 11,
            fontWeight: 600,
            color: "#64748b",
            cursor: "pointer",
          }}
        >
          Skip
        </button>
      </div>
    </div>
  )
}

function Chat({ onAddBatch, acctRole, snap, systemPrompt, welcomeName }) {
  const s = snap || {}
  const w = welcomeName || "your company"
  const [msgs, setMsgs] = useState([
    {
      role: "ai",
      text: `Hello! I'm your **AI Accounting Assistant** for **${w}**.\n\nI use the **live ledger** saved in this browser (per company workspace). Figures in the sidebar follow your data.\n\nAsk about GST, TDS, journal entries, or reports!`,
    },
  ])
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [showKeyPanel, setShowKeyPanel] = useState(() => !hasOpenAiKeyHint())
  const [openaiDraft, setOpenaiDraft] = useState("")
  const [keyBanner, setKeyBanner] = useState("")
  const ref = useRef(null)
  const hist = useRef([])

  useEffect(()=>{ if(ref.current) ref.current.scrollTop=ref.current.scrollHeight },[msgs])

  const chips = ["What is my GST liability?","Explain my B2B revenue","TDS on ₹80,000 salary","GST on ₹1,50,000 invoice","Top 3 expenses?","Journal entry: rent paid ₹20,000"]

  const send = async msg => {
    if(!msg.trim()||busy) return
    setInput("")
    setMsgs(p=>[...p,{role:"user",text:msg}])
    hist.current.push({role:"user",content:msg})
    setBusy(true)
    setMsgs(p=>[...p,{role:"ai",text:"...",loading:true}])
    try {
      const d = await fetchOpenAIChatMessages({
        system: systemPrompt || "",
        messages: hist.current.slice(-10),
        max_tokens: 800,
      })
      const rawText = d.content?.[0]?.text || d.error?.message || "No response"
      const { text, entries } = parseChatPostFooter(rawText)
      hist.current.push({ role: "assistant", content: text })
      setMsgs(p => p.slice(0, -1).concat([{ role: "ai", text }]))
      setBusy(false)
      if (entries.length)
        setTimeout(
          () =>
            setMsgs(p => [
              ...p,
              {
                role: "confirm",
                confirmId: `a-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                entries,
              },
            ]),
          400
        )
      else maybeQueueChatConfirm(msg, setMsgs)
      return
    } catch (e) {
      const hint =
        e?.message === "no_key"
          ? "⚠️ **No API key for chat.** Add **OPENAI_API_KEY** from **https://platform.openai.com/api-keys** on **Render** (Web Service + **npm start**) or **Vercel** (server env — do not rely on **VITE_**-prefixed vars for production secrets), or paste a key under **OpenAI API key** below."
          : e?.message === "bad_openai_key"
            ? "⚠️ **OpenAI rejected this API key.** Create a new secret key at **https://platform.openai.com/api-keys**. Set **OPENAI_API_KEY** on Render/Vercel and remove any wrong **VITE_OPENAI_API_KEY**, then redeploy."
            : `⚠️ **API issue:** ${String(e?.message || e).slice(0, 220)}`
      setMsgs(p=>p.slice(0,-1).concat([{role:"ai",text:hint}]))
    }
    setBusy(false)
    maybeQueueChatConfirm(msg, setMsgs)
  }

  const fmt = t => t ? t.split("\n").map((p,i)=><div key={i} style={{marginBottom:p?2:0}} dangerouslySetInnerHTML={{__html:p.replace(/\*\*(.*?)\*\*/g,"<strong>$1</strong>")||"<br/>"}}/>): null

  return (
    <div style={{display:"flex",gap:14,alignItems:"flex-start"}}>
      <div style={{flex:1,background:"#ffffff",border:"1px solid #bae6fd",borderRadius:14,display:"flex",flexDirection:"column",height:"calc(100vh - 156px)"}}>
        <div style={{padding:"13px 16px",borderBottom:"1px solid #bae6fd"}}>
          <div style={{fontSize:13,fontWeight:700,color:"#0c4a6e",display:"flex",alignItems:"center",gap:8}}>
            ✦ AI Accounting Assistant
            <span style={{background:JM.r(0.15),color:JM.p,border:`1px solid ${JM.r(0.3)}`,padding:"1px 8px",borderRadius:20,fontSize:9.5,fontWeight:700}}>OpenAI</span>
          </div>
          <div style={{fontSize:11,color:"#64748b",marginTop:2}}>Uses your live ledger in this browser · Describe a payment or receipt to draft an entry — you confirm before anything is saved</div>
          <div style={{ marginTop: 10 }}>
            <button
              type="button"
              onClick={() => {
                setShowKeyPanel(p => !p)
                setKeyBanner("")
              }}
              style={{
                background: "transparent",
                border: "none",
                padding: 0,
                fontSize: 10,
                fontWeight: 700,
                color: JM.p,
                cursor: "pointer",
                textDecoration: "underline",
              }}
            >
              {showKeyPanel ? "Hide" : "OpenAI API key"}
            </button>
            {showKeyPanel && (
              <div
                style={{
                  marginTop: 8,
                  padding: 10,
                  background: "#f8fafc",
                  border: `1px solid ${SKY.border}`,
                  borderRadius: 8,
                }}
              >
                <div style={{ fontSize: 10, color: SKY.muted, lineHeight: 1.5, marginBottom: 8 }}>
                  Prefer <code style={{ fontSize: 9 }}>OPENAI_API_KEY</code> on{" "}
                  <strong>Render</strong> (<code style={{ fontSize: 9 }}>npm start</code>) or{" "}
                  <strong>Vercel</strong> — keys from{" "}
                  <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" style={{ color: JM.p }}>
                    platform.openai.com/api-keys
                  </a>
                  . Below saves only in this browser (<strong>localStorage</strong>).
                </div>
                <div style={{ marginBottom: 10 }}>
                  <label style={LB}>Paste key (optional)</label>
                  <input
                    type="password"
                    autoComplete="off"
                    placeholder="sk-…"
                    value={openaiDraft}
                    onChange={e => setOpenaiDraft(e.target.value)}
                    style={{ ...IS, marginBottom: 6 }}
                  />
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={() => {
                        const t = openaiDraft.trim()
                        if (!t) {
                          setKeyBanner("Paste an OpenAI key first.")
                          return
                        }
                        try {
                          localStorage.setItem(OPENAI_KEY_LS, t)
                          setOpenaiDraft("")
                          setKeyBanner("Saved. Send a message to try chat.")
                        } catch {
                          setKeyBanner("Could not save (private mode?).")
                        }
                      }}
                      style={{
                        background: "#0c4a6e",
                        border: "none",
                        borderRadius: 7,
                        padding: "5px 12px",
                        fontSize: 11,
                        fontWeight: 700,
                        color: "#fff",
                        cursor: "pointer",
                      }}
                    >
                      Save OpenAI key
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        try {
                          localStorage.removeItem(OPENAI_KEY_LS)
                          setKeyBanner("OpenAI key removed from this browser.")
                        } catch {
                          setKeyBanner("Could not clear.")
                        }
                      }}
                      style={{
                        background: "transparent",
                        border: `1px solid ${SKY.border}`,
                        borderRadius: 7,
                        padding: "5px 12px",
                        fontSize: 11,
                        fontWeight: 600,
                        color: SKY.muted,
                        cursor: "pointer",
                      }}
                    >
                      Clear saved key
                    </button>
                  </div>
                </div>
                {keyBanner ? (
                  <div style={{ fontSize: 10, color: "#0f766e", marginTop: 8, fontWeight: 600 }}>{keyBanner}</div>
                ) : null}
              </div>
            )}
          </div>
        </div>
        <div ref={ref} style={{flex:1,overflowY:"auto",padding:14,display:"flex",flexDirection:"column",gap:9}}>
          {msgs.map((m,i)=>{
            if(m.role==="confirm"&&Array.isArray(m.entries)&&m.entries.length) return (
              <div key={m.confirmId||i} style={{alignSelf:"flex-start",maxWidth:"100%"}}>
                <ChatConfirmCard
                  acctRole={acctRole}
                  initialEntries={m.entries}
                  onDismiss={()=>setMsgs(p=>p.filter((_,j)=>j!==i))}
                  onAddBatch={rows=>{
                    const ok = onAddBatch(rows)
                    if(ok){
                      const tot = rows.reduce((s,r)=>s+(parseFloat(String(r.amount).replace(/,/g,""))||0),0)
                      setMsgs(p=>p.filter((_,j)=>j!==i).concat([{role:"ai",text:`✅ **Posted** ${rows.length} entr${rows.length===1?"y":"ies"} · ₹${inr(tot)} total`}]))
                    }
                  }}
                />
              </div>
            )
            const u = m.role==="user"
            return <div key={i} style={{maxWidth:"78%",padding:"9px 13px",fontSize:12.5,lineHeight:1.65,alignSelf:u?"flex-end":"flex-start",background:u?JM.gradient:"#ffffff",color:u?"#fff":"#0369a1",border:u?"none":"1px solid #bae6fd",borderRadius:u?"14px 14px 4px 14px":"14px 14px 14px 4px"}}>
              {m.loading?<span style={{color:"#64748b"}}>Thinking…</span>:fmt(m.text)}
            </div>
          })}
        </div>
        <div style={{display:"flex",flexWrap:"wrap",gap:5,padding:"8px 14px",borderTop:"1px solid #bae6fd"}}>
          {chips.map(c=><button key={c} onClick={()=>send(c)} style={{background:"#ffffff",border:"1px solid #bae6fd",borderRadius:20,padding:"4px 10px",fontSize:11,color:"#94a3b8",cursor:"pointer",fontFamily:"inherit"}}>{c}</button>)}
        </div>
        <div style={{display:"flex",gap:8,padding:"10px 14px",borderTop:"1px solid #bae6fd"}}>
          <textarea value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send(input)}}} placeholder="GST, TDS, journals… or e.g. paid ₹20k rent yesterday — I'll suggest an entry for you to confirm" style={{...IS,resize:"none",minHeight:38,maxHeight:88,flex:1}} rows={1}/>
          <button onClick={()=>send(input)} disabled={busy} style={{background:busy?"#bae6fd":JM.p,border:"none",borderRadius:9,padding:"8px 15px",fontSize:12,fontWeight:700,color:"#fff",cursor:busy?"default":"pointer"}}>{busy?"…":"Send ↗"}</button>
        </div>
      </div>
      <div style={{width:250,display:"flex",flexDirection:"column",gap:10}}>
        <div style={{background:"#ffffff",border:"1px solid #bae6fd",borderRadius:12,padding:14}}>
          <div style={{fontSize:12,fontWeight:700,color:"#0c4a6e",marginBottom:10}}>💼 Live Financials</div>
          {[["Bank balance","₹"+inr0(s.balance??0),"#6B7AFF"],["Top revenue cat",(s.topRevName||"—")+" · ₹"+inr0(s.topRevAmt??0),"#10b981"],["Salary (DR)","₹"+inr0(s.salaryDr??0),"#f43f5e"],["Output GST (est.)","₹"+inr0(s.gstEst??0),"#f59e0b"],["IT refund (CR)","₹"+inr0(s.itRefund??0),"#10b981"],["Transactions",String(s.count??0),"#94a3b8"]].map(([k,v,c])=>(
            <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"5px 9px",background:"#ffffff",borderRadius:7,marginBottom:4,fontSize:11}}>
              <span style={{color:"#64748b"}}>{k}</span><span style={{fontWeight:700,color:c}}>{v}</span>
            </div>
          ))}
        </div>
        <div style={{background:"#ffffff",border:"1px solid #bae6fd",borderRadius:12,padding:14}}>
          <div style={{fontSize:12,fontWeight:700,color:"#0c4a6e",marginBottom:9}}>📅 Compliance</div>
          {[{dt:"20 Mar",t:"GSTR-3B Payment",d:0,c:"#f43f5e"},{dt:"31 Mar",t:"Advance Tax Q4",d:11,c:"#f59e0b"},{dt:"7 Apr",t:"TDS Challan 281",d:18,c:"#6B7AFF"},{dt:"11 Apr",t:"GSTR-1 Filing",d:22,c:"#6B7AFF"}].map(c=>(
            <div key={c.t} style={{display:"flex",gap:9,alignItems:"center",padding:"6px 8px",background:"#ffffff",borderRadius:8,marginBottom:5}}>
              <div style={{width:34,height:34,borderRadius:7,background:c.d===0?"rgba(244,63,94,.15)":"rgba(107,122,255,.1)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:800,color:c.c,lineHeight:1.2,textAlign:"center",flexShrink:0}}>{c.dt.split(" ")[0]}<br/>{c.dt.split(" ")[1]}</div>
              <div><div style={{fontSize:11,fontWeight:600,color:"#0c4a6e"}}>{c.t}</div><div style={{fontSize:10,color:c.d===0?"#f43f5e":"#64748b"}}>{c.d===0?"🔴 DUE TODAY":"In "+c.d+"d"}</div></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ═══════════════ MAIN APP ═══════════════
export default function App() {
  const [txns, setTxns] = useState(null)
  const [page, setPage] = useState("dash")
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState(null)
  const [coDraft, setCoDraft] = useState({ name: "", legalName: "", bankAccountLabel: "" })
  const [toast, setToast] = useState(null)
  const [search, setSearch] = useState("")
  const [fCat, setFCat] = useState("")
  const [fDC, setFDC] = useState("")
  const [ledAcc, setLedAcc] = useState("Primary bank account")
  const [gTab, setGTab] = useState("mon")
  const [pTab, setPTab] = useState("all")
  const [rTab, setRTab] = useState("pl")
  const [iTab, setITab] = useState("rev")
  const [nt, setNt] = useState({date:todayISO(),particulars:"",amount:"",drCr:"Debit",category:"Misc Expense",ref:""})
  const [ni, setNi] = useState({
    num: "INV-0001",
    date: todayISO(),
    dueDays: "30",
    dueDate: addDaysISO(todayISO(), 30),
    client: "",
    gstin: "",
    taxable: "",
    gst_rate: "18",
    sac: "998314",
    desc: "",
    place: "intra",
    revenueCategory: REVENUE_CATS[0] || "Revenue - B2B Services",
    notes: "",
  })
  const [acctRole, setAcctRole] = useState("Admin")
  const [periodLockIso, setPeriodLockIso] = useState("")
  const [showVoid, setShowVoid] = useState(false)
  const [repFy, setRepFy] = useState("")
  const [repMonthKey, setRepMonthKey] = useState("")
  const [repFromIso, setRepFromIso] = useState("")
  const [repToIso, setRepToIso] = useState("")
  const [inventory, setInventory] = useState([])
  const [importHistory, setImportHistory] = useState([])
  const [invoices, setInvoices] = useState([])
  const [invView, setInvView] = useState("sales")
  const [invListFilter, setInvListFilter] = useState("open")
  const [invPayId, setInvPayId] = useState(null)
  const [invPayAmt, setInvPayAmt] = useState("")
  const [invPayTds, setInvPayTds] = useState("")
  const [dangerFlow, setDangerFlow] = useState(null)
  const [dangerRemark, setDangerRemark] = useState("")
  const [dangerAck, setDangerAck] = useState(false)
  const [companies, setCompanies] = useState([])
  const [activeCompanyId, setActiveCompanyId] = useState("")
  const skipPersistRef = useRef(false)

  useEffect(() => {
    ;(async () => {
      try {
        const { registry, activeCompanyId: aid, payload } = await bootstrapCompanies(store, STORAGE_EPOCH)
        setCompanies(registry.companies || [])
        setActiveCompanyId(aid)
        const raw = (Array.isArray(payload.txns) ? payload.txns : []).map(t => enrichTxnJournal({ ...t, void: !!t.void }))
        setTxns(withRecalculatedBalances(normalizeTxnCategories(raw)))
        const invDoc = payload.invoices
        if (Array.isArray(invDoc))
          setInvoices(invDoc.map((row, i) => normalizeInvoiceRow({ ...row, id: row.id != null ? row.id : i + 1 })))
        else setInvoices([])
        setInventory(Array.isArray(payload.inventory) ? payload.inventory : [])
        setImportHistory(Array.isArray(payload.importHistory) ? payload.importHistory : [])
        const st = payload.settings
        if (st?.acctRole) setAcctRole(st.acctRole)
        if (st?.periodLockIso != null) setPeriodLockIso(st.periodLockIso)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  useEffect(() => {
    if (loading || !activeCompanyId || txns === null || skipPersistRef.current) return
    persistCompanyPayload(store, activeCompanyId, {
      txns,
      invoices,
      inventory,
      importHistory,
      settings: { acctRole, periodLockIso },
    })
  }, [txns, invoices, inventory, importHistory, acctRole, periodLockIso, activeCompanyId, loading])

  const appendAudit = useCallback(async entry => {
    if (!activeCompanyId) return
    await appendCompanyAudit(store, activeCompanyId, entry)
  }, [activeCompanyId])

  const toast_ = (msg, c="#10b981") => { setToast({msg,c}); setTimeout(()=>setToast(null),2800) }

  const stats = useMemo(()=>{
    if(!txns) return {cr:0,dr:0,balance:0,flowNet:0,count:0}
    const act = txns.filter(t=>!t.void)
    const cash = act.filter(t => !t.excludeFromBankRunning)
    const cr = cash.filter(t=>t.drCr==="CR").reduce((s,t)=>s+t.amount,0)
    const dr = cash.filter(t=>t.drCr==="DR").reduce((s,t)=>s+t.amount,0)
    const sorted = [...act].sort((a,b)=>parseDdMmYyyy(a.date)-parseDdMmYyyy(b.date)||a.id-b.id)
    const last = sorted[sorted.length-1]
    const closing = last?.balance != null && Number.isFinite(Number(last.balance)) ? Number(last.balance) : 0
    return {cr,dr,balance:closing,flowNet:Math.round((cr-dr)*100)/100,count:act.length}
  },[txns])

  const ledger = txns ?? []
  const reportLedger = useMemo(
    () =>
      filterTxnsForReport(ledger, {
        fy: repFy || undefined,
        monthKey: repMonthKey || undefined,
        fromIso: repFromIso || undefined,
        toIso: repToIso || undefined,
      }),
    [ledger, repFy, repMonthKey, repFromIso, repToIso]
  )

  const reportStats = useMemo(() => {
    const act = reportLedger
    if (!act.length) return { cr: 0, dr: 0, balance: 0, flowNet: 0, count: 0 }
    const cash = act.filter(t => !t.excludeFromBankRunning)
    const cr = cash.filter(t => t.drCr === "CR").reduce((s, t) => s + t.amount, 0)
    const dr = cash.filter(t => t.drCr === "DR").reduce((s, t) => s + t.amount, 0)
    const sorted = [...act].sort((a, b) => parseDdMmYyyy(a.date) - parseDdMmYyyy(b.date) || a.id - b.id)
    const last = sorted[sorted.length - 1]
    const closing = last?.balance != null && Number.isFinite(Number(last.balance)) ? Number(last.balance) : 0
    return { cr, dr, balance: closing, flowNet: Math.round((cr - dr) * 100) / 100, count: act.length }
  }, [reportLedger])

  const monthlyFlow = useMemo(() => aggregateMonthlyCashflow(reportLedger), [reportLedger])
  const crByCat = useMemo(() => aggregateByCategory(reportLedger, "CR"), [reportLedger])
  const drByCat = useMemo(() => aggregateByCategory(reportLedger, "DR"), [reportLedger])
  const tbReport = useMemo(() => trialBalanceFromJournal(reportLedger), [reportLedger])
  const outputGstFromRev = useMemo(() => estimatedTotalOutputGst(reportLedger), [reportLedger])
  const outputGstFullBook = useMemo(() => estimatedTotalOutputGst(ledger), [ledger])
  const revenueCats = useMemo(() => crByCat.filter(([n]) => String(n).startsWith("Revenue")), [crByCat])
  const revCatTotal = useMemo(() => revenueCats.reduce((s, [, v]) => s + v, 0), [revenueCats])
  const capitalCr = useMemo(
    () => reportLedger.filter(t => t.drCr === "CR" && String(t.category || "").startsWith("Capital")).reduce((s, t) => s + (Number(t.amount) || 0), 0),
    [reportLedger]
  )
  const dirDrawTotal = useMemo(
    () => reportLedger.filter(t => t.drCr === "DR" && t.category === "Director Payment").reduce((s, t) => s + (Number(t.amount) || 0), 0),
    [reportLedger]
  )
  const cfBuckets = useMemo(() => {
    const act = reportLedger
    const S = pred => act.filter(pred).reduce((s, t) => s + (Number(t.amount) || 0), 0)
    const cr = S(t => t.drCr === "CR")
    const dr = S(t => t.drCr === "DR")
    const cap = S(t => t.drCr === "CR" && String(t.category || "").startsWith("Capital"))
    const revSvc = S(t => t.drCr === "CR" && String(t.category || "").startsWith("Revenue"))
    const salRem = S(t => t.drCr === "DR" && (t.category === "Salary" || t.category === "Director Payment"))
    const vendor = S(
      t => t.drCr === "DR" && (String(t.category || "").startsWith("Vendor") || String(t.category || "").startsWith("Recruitment"))
    )
    const misc = S(t => t.drCr === "DR" && t.category === "Misc Expense")
    const bankCh = S(t => t.drCr === "DR" && t.category === "Bank Charges")
    const otherDr = Math.round((dr - salRem - vendor - misc - bankCh) * 100) / 100
    const otherCr = Math.round((cr - revSvc - cap) * 100) / 100
    return { cr, dr, cap, revSvc, salRem, vendor, misc, bankCh, otherDr, otherCr }
  }, [reportLedger])

  const chatRevenueCats = useMemo(
    () => aggregateByCategory(ledger, "CR").filter(([n]) => String(n).startsWith("Revenue")),
    [ledger, txns]
  )
  const chatSnap = useMemo(() => {
    const tr = chatRevenueCats[0]
    const recentLines = [...ledger]
      .filter(t => !t.void)
      .slice(-28)
      .map(t => {
        const p = String(t.particulars || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 130)
        const extra =
          t.bankRemark && !p.toLowerCase().includes("remarks:")
            ? ` | Remark: ${String(t.bankRemark).replace(/\s+/g, " ").trim().slice(0, 70)}`
            : ""
        return `${t.date} · ${t.drCr} · ₹${inr0(t.amount)} · ${t.category} · ${p}${extra}`
      })
      .join("\n")
    return {
      balance: stats.balance,
      topRevName: tr ? String(tr[0]).replace(/^Revenue -\s*/, "") : "—",
      topRevAmt: tr ? tr[1] : 0,
      salaryDr: ledger.filter(t => !t.void && t.drCr === "DR" && t.category === "Salary").reduce((s, t) => s + (Number(t.amount) || 0), 0),
      gstEst: outputGstFullBook,
      itRefund: ledger.filter(t => !t.void && t.drCr === "CR" && t.category === "Income Tax Refund").reduce((s, t) => s + (Number(t.amount) || 0), 0),
      count: stats.count,
      recentLines,
    }
  }, [ledger, stats.balance, stats.count, chatRevenueCats, outputGstFullBook])

  const activeCompany = useMemo(
    () => companies.find(c => c.id === activeCompanyId) || null,
    [companies, activeCompanyId]
  )
  const chatSystemPrompt = useMemo(() => buildChatSystemPrompt(activeCompany, chatSnap), [activeCompany, chatSnap])

  useEffect(() => {
    if (modal !== "companies") return
    const c = companies.find(x => x.id === activeCompanyId)
    if (!c) return
    setCoDraft({
      name: c.name || "",
      legalName: c.legalName || "",
      bankAccountLabel: c.bankAccountLabel || "",
    })
  }, [modal, companies, activeCompanyId])

  const flushActiveToStorage = useCallback(async () => {
    if (!activeCompanyId || txns === null) return
    await persistCompanyPayload(store, activeCompanyId, {
      txns,
      invoices,
      inventory,
      importHistory,
      settings: { acctRole, periodLockIso },
    })
  }, [activeCompanyId, txns, invoices, inventory, importHistory, acctRole, periodLockIso])

  const applyLoadedPayload = useCallback(payload => {
    const raw = (Array.isArray(payload.txns) ? payload.txns : []).map(t => enrichTxnJournal({ ...t, void: !!t.void }))
    setTxns(withRecalculatedBalances(normalizeTxnCategories(raw)))
    const invDoc = payload.invoices
    if (Array.isArray(invDoc))
      setInvoices(invDoc.map((row, i) => normalizeInvoiceRow({ ...row, id: row.id != null ? row.id : i + 1 })))
    else setInvoices([])
    setInventory(Array.isArray(payload.inventory) ? payload.inventory : [])
    setImportHistory(Array.isArray(payload.importHistory) ? payload.importHistory : [])
    const st = payload.settings
    setAcctRole(st?.acctRole || "Admin")
    setPeriodLockIso(st?.periodLockIso != null ? st.periodLockIso : "")
  }, [])

  const switchCompany = useCallback(
    async newId => {
      if (!newId || newId === activeCompanyId || loading) return
      skipPersistRef.current = true
      try {
        await flushActiveToStorage()
        const reg = (await readRegistry(store)) || { companies: [], activeCompanyId: "" }
        const nextReg = { ...reg, activeCompanyId: newId }
        await writeRegistry(store, nextReg)
        const payload = await loadCompanyPayload(store, newId)
        setActiveCompanyId(newId)
        setCompanies(nextReg.companies || [])
        applyLoadedPayload(payload)
        toast_("Switched company workspace", "#6B7AFF")
      } catch (e) {
        toast_(String(e?.message || e), "#f43f5e")
      } finally {
        skipPersistRef.current = false
      }
    },
    [activeCompanyId, loading, flushActiveToStorage, applyLoadedPayload]
  )

  const addCompany = useCallback(async () => {
    const name = prompt("Company / workspace name (shown in the app header)")
    if (name == null) return
    const trimmed = name.trim() || "New company"
    skipPersistRef.current = true
    try {
      await flushActiveToStorage()
      const id = newCompanyId()
      const reg = (await readRegistry(store)) || { version: 1, companies, activeCompanyId }
      const nextReg = {
        ...reg,
        companies: [...(reg.companies || []), { id, name: trimmed, legalName: "", bankAccountLabel: "" }],
        activeCompanyId: id,
      }
      await writeRegistry(store, nextReg)
      await persistCompanyPayload(store, id, {
        txns: [],
        invoices: [],
        inventory: [],
        importHistory: [],
        settings: { acctRole: "Admin", periodLockIso: "" },
      })
      const payload = await loadCompanyPayload(store, id)
      setActiveCompanyId(id)
      setCompanies(nextReg.companies)
      applyLoadedPayload(payload)
      toast_("New company added — empty books", "#10b981")
    } catch (e) {
      toast_(String(e?.message || e), "#f43f5e")
    } finally {
      skipPersistRef.current = false
    }
  }, [activeCompanyId, companies, flushActiveToStorage, applyLoadedPayload])

  const saveCompanyProfile = useCallback(
    async (id, patch) => {
      const reg = await readRegistry(store)
      if (!reg?.companies) return
      const next = {
        ...reg,
        companies: reg.companies.map(c => (c.id === id ? { ...c, ...patch } : c)),
      }
      await writeRegistry(store, next)
      setCompanies(next.companies)
      toast_("Company details saved", "#10b981")
    },
    []
  )

  const deleteCompany = useCallback(
    async id => {
      if (companies.length <= 1) {
        toast_("Keep at least one company workspace", "#f43f5e")
        return
      }
      if (!confirm("Delete this company and all its books, invoices, and history? This cannot be undone.")) return
      skipPersistRef.current = true
      try {
        const reg = await readRegistry(store)
        if (!reg?.companies) return
        const rest = reg.companies.filter(c => c.id !== id)
        if (!rest.length) return
        if (id === reg.activeCompanyId) {
          await removeCompanyData(store, id)
          const nextActive = rest[0].id
          const nextReg = { ...reg, companies: rest, activeCompanyId: nextActive }
          await writeRegistry(store, nextReg)
          const payload = await loadCompanyPayload(store, nextActive)
          setActiveCompanyId(nextActive)
          setCompanies(rest)
          applyLoadedPayload(payload)
        } else {
          await removeCompanyData(store, id)
          const nextReg = { ...reg, companies: rest }
          await writeRegistry(store, nextReg)
          setCompanies(rest)
        }
        toast_("Company removed", "#f59e0b")
      } catch (e) {
        toast_(String(e?.message || e), "#f43f5e")
      } finally {
        skipPersistRef.current = false
      }
    },
    [companies.length, applyLoadedPayload]
  )

  const addTxn = useCallback(d=>{
    if (acctRole==="Viewer"){toast_("Viewer role — cannot post entries","#f43f5e");return}
    const data = d||nt
    const amount = parseFloat(String(data.amount).replace(/,/g,""))||0
    if(!amount||!data.particulars){toast_("Please fill amount & description","#f43f5e");return}
    const drCr = (data.drCr||"Debit").startsWith("C")?"CR":"DR"
    const dateStr = isoToDdMmYyyy(data.date||todayISO())
    const cat = data.category||"Misc Expense"
    if (periodLockIso && isPeriodLocked(dateStr, periodLockIso)){
      toast_("Date falls in a locked period — posting blocked","#f43f5e")
      return
    }
    const active = txns.filter(t=>!t.void)
    if (isDuplicateTxn(active,{date:dateStr,amount,particulars:data.particulars})){
      if (!confirm("Possible duplicate (same date, amount & narration). Post anyway?")) return
    }
    const journalLines = buildJournalLines({ amount, drCr, category: cat })
    const v = validateBalanced(journalLines)
    if (!v.ok){toast_(v.errors[0]||"Unbalanced journal","#f43f5e");return}
    const newId = Math.max(...txns.map(t=>t.id),0)+1
    const t = {
      id:newId,
      date:dateStr,
      particulars:data.particulars,
      amount,
      drCr,
      category:cat,
      fy:inferFY(dateStr),
      journalLines,
      void:false,
      audit:{createdAt:new Date().toISOString(),createdBy:acctRole,ref:data.ref||""},
    }
    const next = withRecalculatedBalances([...txns,t])
    const lastBal = [...next].filter(x=>!x.void).sort((a,b)=>parseDdMmYyyy(a.date)-parseDdMmYyyy(b.date)||a.id-b.id).pop()?.balance
    if (lastBal!=null && lastBal<0) toast_("Warning: bank balance negative after posting","#f59e0b")
    setTxns(next)
    appendAudit({action:"POST",txnId:newId,by:acctRole,particulars:t.particulars,amount,drCr,category:cat})
    setModal(null)
    setNt({date:todayISO(),particulars:"",amount:"",drCr:"Debit",category:"Misc Expense",ref:""})
    toast_("✓ Posted — ₹"+inr(amount)+" (Dr=Cr · "+journalLines.length+" lines)")
  },[txns,nt,acctRole,periodLockIso,appendAudit])

  const addTxnBatchFromChat = useCallback(
    rows => {
      if (acctRole === "Viewer") {
        toast_("Viewer role — cannot post entries", "#f43f5e")
        return false
      }
      if (!Array.isArray(rows) || !rows.length) return false
      let acc = [...txns]
      let nextId = Math.max(...acc.map(t => t.id), 0)
      const built = []
      for (const data of rows) {
        const amount = parseFloat(String(data.amount).replace(/,/g, "")) || 0
        if (!amount || !String(data.particulars || "").trim()) {
          toast_("Please fill amount & description for every line", "#f43f5e")
          return false
        }
        const drCr =
          String(data.drCr || "Debit").toUpperCase() === "CR" || String(data.drCr || "").startsWith("C")
            ? "CR"
            : "DR"
        const dateStr = isoToDdMmYyyy(data.date || todayISO())
        const cat = data.category || "Misc Expense"
        if (periodLockIso && isPeriodLocked(dateStr, periodLockIso)) {
          toast_("Date falls in a locked period — posting blocked", "#f43f5e")
          return false
        }
        const active = acc.filter(t => !t.void)
        if (isDuplicateTxn(active, { date: dateStr, amount, particulars: data.particulars })) {
          if (!confirm("Possible duplicate (same date, amount & narration). Post anyway?")) return false
        }
        const journalLines = buildJournalLines({ amount, drCr, category: cat })
        const v = validateBalanced(journalLines)
        if (!v.ok) {
          toast_(v.errors[0] || "Unbalanced journal", "#f43f5e")
          return false
        }
        nextId += 1
        const t = {
          id: nextId,
          date: dateStr,
          particulars: data.particulars,
          amount,
          drCr,
          category: cat,
          fy: inferFY(dateStr),
          journalLines,
          void: false,
          audit: { createdAt: new Date().toISOString(), createdBy: acctRole, ref: data.ref || "" },
        }
        acc = [...acc, t]
        built.push(t)
      }
      const next = withRecalculatedBalances(acc)
      const lastBal = [...next]
        .filter(x => !x.void)
        .sort((a, b) => parseDdMmYyyy(a.date) - parseDdMmYyyy(b.date) || a.id - b.id)
        .pop()?.balance
      if (lastBal != null && lastBal < 0) toast_("Warning: bank balance negative after posting", "#f59e0b")
      setTxns(next)
      for (const t of built)
        appendAudit({
          action: "POST",
          txnId: t.id,
          by: acctRole,
          particulars: t.particulars,
          amount: t.amount,
          drCr: t.drCr,
          category: t.category,
        })
      return true
    },
    [txns, acctRole, periodLockIso, appendAudit]
  )

  const handleBankStatementFile = useCallback(
    async e => {
      const input = e.target
      const f = input.files?.[0]
      input.value = ""
      if (!f || !txns) return
      if (acctRole === "Viewer") {
        toast_("Viewer role — cannot import", "#f43f5e")
        return
      }
      const rid = `imp-${Date.now()}`
      setImportHistory(h => [{ rid, d: today(), f: f.name, p: "—", t: 0, status: "Importing…" }, ...h])
      try {
        const matrix = await bankFileToImportMatrix(f)
        const res = importBankStatementFromMatrix(matrix, {
          txns,
          periodLockIso,
          acctRole,
          fileName: f.name,
        })
        if (res.error) {
          const hint = res.headerHint ? ` Sample headers: ${res.headerHint.slice(0, 100)}${res.headerHint.length > 100 ? "…" : ""}` : ""
          toast_(res.error + hint, "#f43f5e")
          setImportHistory(h =>
            h.map(row => (row.rid === rid ? { ...row, status: "Failed", p: "—", t: 0 } : row))
          )
          return
        }
        if (!res.newTxns.length) {
          toast_(
            `No new rows added (duplicates ${res.stats.dup}, locked period ${res.stats.lock}, invalid ${res.stats.bad}).`,
            "#f59e0b"
          )
          setImportHistory(h =>
            h.map(row => (row.rid === rid ? { ...row, p: res.period, t: 0, status: "Nothing new" } : row))
          )
          return
        }
        const merged = [...txns, ...res.newTxns].map(t => enrichTxnJournal(t))
        setTxns(withRecalculatedBalances(normalizeTxnCategories(merged)))
        appendAudit({
          action: "BULK_IMPORT",
          by: acctRole,
          file: f.name,
          count: res.newTxns.length,
          stats: res.stats,
        })
        const parts = [`Imported ${res.newTxns.length} transactions`]
        if (res.stats.dup) parts.push(`${res.stats.dup} dup skipped`)
        if (res.stats.lock) parts.push(`${res.stats.lock} locked skipped`)
        toast_(parts.join(" · "), "#10b981")
        setImportHistory(h =>
          h.map(row => (row.rid === rid ? { ...row, p: res.period, t: res.newTxns.length, status: "Done" } : row))
        )
      } catch (err) {
        toast_(String(err?.message || err), "#f43f5e")
        setImportHistory(h => h.map(row => (row.rid === rid ? { ...row, status: "Failed", t: 0 } : row)))
      }
    },
    [txns, acctRole, periodLockIso, appendAudit]
  )

  const closeDangerModal = useCallback(() => {
    setDangerFlow(null)
    setDangerRemark("")
    setDangerAck(false)
  }, [])

  const openVoidConfirm = useCallback(
    id => {
      if (acctRole === "Viewer") {
        toast_("Viewer role — cannot void", "#f43f5e")
        return
      }
      setDangerFlow({ kind: "void", id })
      setDangerRemark("")
      setDangerAck(false)
    },
    [acctRole]
  )

  const openInvoiceDeleteConfirm = useCallback(
    id => {
      if (acctRole === "Viewer") return
      setDangerFlow({ kind: "invoice", id })
      setDangerRemark("")
      setDangerAck(false)
    },
    [acctRole]
  )

  const confirmDangerAction = useCallback(() => {
    if (acctRole === "Viewer" || !dangerFlow) return
    const remark = dangerRemark.trim()
    if (remark.length < 3) {
      toast_("Enter a remark (at least 3 characters)", "#f43f5e")
      return
    }
    if (!dangerAck) {
      toast_("Tick the box to confirm", "#f43f5e")
      return
    }
    if (dangerFlow.kind === "void") {
      const id = dangerFlow.id
      const victim = txns?.find(x => x.id === id)
      if (!victim) {
        toast_("Entry not found", "#f43f5e")
        closeDangerModal()
        return
      }
      setTxns(p => {
        const marked = p.map(x =>
          x.id === id
            ? {
                ...x,
                void: true,
                voidedAt: new Date().toISOString(),
                voidedBy: acctRole,
                voidReason: remark,
                balance: null,
              }
            : x
        )
        const stripped = stripBalancesAfter(marked, victim.date, victim.id)
        return withRecalculatedBalances(stripped)
      })
      appendAudit({ action: "VOID", txnId: id, by: acctRole, remark })
      toast_("Entry voided", "#f59e0b")
    } else {
      const id = dangerFlow.id
      const inv = invoices.find(i => i.id === id)
      if (!inv) {
        toast_("Invoice not found", "#f43f5e")
        closeDangerModal()
        return
      }
      setInvoices(list => list.filter(i => i.id !== id))
      appendAudit({
        action: "INVOICE_DELETE",
        invoiceId: id,
        num: inv.num,
        remark,
      })
      toast_("Invoice removed", "#f59e0b")
    }
    closeDangerModal()
  }, [acctRole, dangerFlow, dangerRemark, dangerAck, invoices, txns, appendAudit, closeDangerModal])

  const openCreateInvoiceModal = () => {
    if (acctRole === "Viewer") {
      toast_("Viewer role — cannot create invoices", "#f43f5e")
      return
    }
    const d = todayISO()
    setNi({
      num: suggestNextInvoiceNum(invoices),
      date: d,
      dueDays: "30",
      dueDate: addDaysISO(d, 30),
      client: "",
      gstin: "",
      taxable: "",
      gst_rate: "18",
      sac: "998314",
      desc: "",
      place: "intra",
      revenueCategory: REVENUE_CATS[0] || "Revenue - B2B Services",
      notes: "",
    })
    setModal("inv")
  }

  const saveInvoiceFromModal = () => {
    if (acctRole === "Viewer") return
    const g = computeInvoiceGst(ni.taxable, ni.gst_rate, ni.place)
    const taxable = parseFloat(String(ni.taxable).replace(/,/g, "")) || 0
    if (!ni.client.trim()) {
      toast_("Enter client name", "#f43f5e")
      return
    }
    if (!ni.num.trim()) {
      toast_("Enter invoice number", "#f43f5e")
      return
    }
    if (!taxable || taxable <= 0) {
      toast_("Enter taxable value (pre-GST)", "#f43f5e")
      return
    }
    if (invoices.some(x => x.num === ni.num.trim())) {
      toast_("Duplicate invoice #", "#f43f5e")
      return
    }
    const dueDate = ni.dueDate || addDaysISO(ni.date, parseInt(ni.dueDays, 10) || 30)
    const inv = normalizeInvoiceRow({
      id: Math.max(0, ...invoices.map(x => x.id)) + 1,
      num: ni.num.trim(),
      date: ni.date,
      dueDate,
      client: ni.client.trim(),
      gstin: ni.gstin.trim(),
      sac: ni.sac.trim(),
      taxable,
      gst_rate: parseFloat(ni.gst_rate) || 0,
      cgst: g.cgst,
      sgst: g.sgst,
      igst: g.igst,
      total: g.total,
      desc: ni.desc,
      place: ni.place,
      revenueCategory: ni.revenueCategory,
      notes: ni.notes || "",
      status: "sent",
      paidAmount: 0,
      paidBankTotal: 0,
      paidTdsTotal: 0,
      paidAt: "",
      createdAt: new Date().toISOString(),
    })
    setInvoices(h => [...h, inv])
    appendAudit({ action: "INVOICE_CREATE", invoiceId: inv.id, num: inv.num, total: inv.total })
    toast_("Saved · " + inv.num + " · ₹" + inr(inv.total), "#10b981")
    setModal(null)
  }

  const markInvoicePaidFull = useCallback(
    id => {
      if (acctRole === "Viewer") return
      const inv = invoices.find(i => i.id === id)
      if (!inv) return
      const tot = Number(inv.total) || 0
      const cur = Number(inv.paidAmount) || 0
      const rem = Math.round((tot - cur) * 100) / 100
      if (rem <= 0.005) {
        toast_("Invoice already fully paid", "#f59e0b")
        return
      }
      const pb0 = Number(inv.paidBankTotal)
      const bankBase = Number.isFinite(pb0) ? pb0 : cur
      const paidAt = todayISO()
      const dateDdMmYyyy = isoToDdMmYyyy(paidAt)
      if (periodLockIso && isPeriodLocked(dateDdMmYyyy, periodLockIso)) {
        toast_("Date falls in a locked period — posting blocked", "#f43f5e")
        return
      }
      const nextInv = {
        ...inv,
        status: "paid",
        paidAmount: tot,
        paidBankTotal: rem > 0.01 ? Math.round((bankBase + rem) * 100) / 100 : Math.round(bankBase * 100) / 100,
        paidTdsTotal: Number(inv.paidTdsTotal) || 0,
        paidAt,
      }
      const res = draftInvoiceSettlementTxns({
        prevTxns: txns,
        inv: nextInv,
        incBank: rem,
        incTds: 0,
        dateDdMmYyyy,
      })
      if (res.error) {
        toast_(res.error, "#f43f5e")
        return
      }
      setInvoices(list => list.map(i => (i.id === id ? nextInv : i)))
      if (res.drafts?.length) {
        const createdAt = new Date().toISOString()
        const stamped = res.drafts.map(d => ({
          ...d,
          audit: { ...d.audit, createdAt, createdBy: acctRole },
        }))
        setTxns(prev =>
          withRecalculatedBalances(normalizeTxnCategories([...prev, ...stamped].map(t => enrichTxnJournal(t))))
        )
      }
      appendAudit({ action: "INVOICE_PAID", invoiceId: id })
      toast_("Marked paid · bank receipt posted to ledger", "#10b981")
    },
    [invoices, txns, acctRole, periodLockIso, appendAudit]
  )

  const exportInvoicesCsv = () => {
    const header =
      "Invoice #,Date,Due Date,Client,GSTIN,SAC,Taxable,GST%,CGST,SGST,IGST,Total,Paid_settlement,Bank_received,TDS_deducted,Balance,Status,Category,Description\n"
    const body = invoices
      .map(inv => {
        const bal = invoiceBalance(inv)
        const st = invoiceUiStatus(inv)
        return [
          inv.num,
          inv.date,
          inv.dueDate,
          `"${String(inv.client).replace(/"/g, '""')}"`,
          inv.gstin,
          inv.sac,
          inv.taxable,
          inv.gst_rate,
          inv.cgst,
          inv.sgst,
          inv.igst,
          inv.total,
          inv.paidAmount,
          Number(inv.paidBankTotal ?? inv.paidAmount) || 0,
          Number(inv.paidTdsTotal) || 0,
          bal,
          st,
          `"${String(inv.revenueCategory).replace(/"/g, '""')}"`,
          `"${String(inv.desc).replace(/"/g, '""').slice(0, 200)}"`,
        ].join(",")
      })
      .join("\n")
    const b = new Blob([header + body], { type: "text/csv" })
    const a = document.createElement("a")
    a.href = URL.createObjectURL(b)
    a.download = "jm_tally_invoices.csv"
    a.click()
    toast_("Invoices exported", "#10b981")
  }

  const applyInvoicePaymentModal = useCallback(() => {
    if (acctRole === "Viewer" || invPayId == null) return
    const inv0 = invoices.find(i => i.id === invPayId)
    if (!inv0) return
    const received = Math.round((parseFloat(String(invPayAmt).replace(/,/g, "")) || 0) * 100) / 100
    const tds = Math.round((parseFloat(String(invPayTds).replace(/,/g, "")) || 0) * 100) / 100
    if (received <= 0 && tds <= 0) {
      toast_("Enter bank receipt and/or TDS deducted by client (₹)", "#f43f5e")
      return
    }
    const tot = Number(inv0.total) || 0
    const bal = invoiceBalance(inv0)
    const settlement = Math.round((received + tds) * 100) / 100
    let incBank = received
    let incTds = tds
    let increment = settlement
    if (settlement > bal + 0.001 && settlement > 0) {
      increment = Math.round(bal * 100) / 100
      incBank = Math.round((received * bal) / settlement * 100) / 100
      incTds = Math.round((increment - incBank) * 100) / 100
    }
    const capped = Math.round((Number(inv0.paidAmount) + increment) * 100) / 100
    const paid = capped >= tot - 0.01
    const pb0 = Number(inv0.paidBankTotal)
    const pt0 = Number(inv0.paidTdsTotal)
    const baseBank = Number.isFinite(pb0) ? pb0 : Number(inv0.paidAmount) || 0
    const baseTds = Number.isFinite(pt0) ? pt0 : 0
    const nextInv = {
      ...inv0,
      paidAmount: Math.min(capped, tot),
      paidBankTotal: Math.round((baseBank + incBank) * 100) / 100,
      paidTdsTotal: Math.round((baseTds + incTds) * 100) / 100,
      status: paid ? "paid" : "partial",
      paidAt: paid ? todayISO() : inv0.paidAt,
    }
    const paymentDateIso = todayISO()
    const dateDdMmYyyy = isoToDdMmYyyy(paymentDateIso)
    if (periodLockIso && isPeriodLocked(dateDdMmYyyy, periodLockIso)) {
      toast_("Date falls in a locked period — posting blocked", "#f43f5e")
      return
    }
    const res = draftInvoiceSettlementTxns({
      prevTxns: txns,
      inv: nextInv,
      incBank,
      incTds,
      dateDdMmYyyy,
    })
    if (res.error) {
      toast_(res.error, "#f43f5e")
      return
    }
    setInvoices(list => list.map(inv => (inv.id === invPayId ? nextInv : inv)))
    if (res.drafts?.length) {
      const createdAt = new Date().toISOString()
      const stamped = res.drafts.map(d => ({
        ...d,
        audit: { ...d.audit, createdAt, createdBy: acctRole },
      }))
      setTxns(prev =>
        withRecalculatedBalances(normalizeTxnCategories([...prev, ...stamped].map(t => enrichTxnJournal(t))))
      )
    }
    appendAudit({
      action: "INVOICE_PAYMENT",
      invoiceId: invPayId,
      bank: received,
      tds,
      settlement: received + tds,
    })
    const sumMsg =
      tds > 0
        ? `Posted to ledger · Bank ₹${inr(received)} + TDS ₹${inr(tds)} = ₹${inr(received + tds)}`
        : `Posted to ledger · Bank ₹${inr(received)}`
    toast_(sumMsg, "#10b981")
    setInvPayId(null)
    setInvPayAmt("")
    setInvPayTds("")
  }, [acctRole, invPayId, invPayAmt, invPayTds, invoices, txns, periodLockIso, appendAudit])

  const filtered = useMemo(()=>{
    if(!txns) return []
    let f = showVoid ? txns : txns.filter(t=>!t.void)
    if (search) {
      const q = search.toLowerCase()
      f = f.filter(
        t =>
          t.particulars.toLowerCase().includes(q) ||
          t.category.toLowerCase().includes(q) ||
          String(t.bankRemark || "")
            .toLowerCase()
            .includes(q)
      )
    }
    if(fCat) f = f.filter(t=>t.category===fCat)
    if(fDC) f = f.filter(t=>t.drCr===fDC)
    if(repFy) f = f.filter(t=>t.fy===repFy)
    return f
  },[txns,search,fCat,fDC,repFy,showVoid])

  if (loading)
    return (
      <div
        style={{
          height: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: SKY.page,
          flexDirection: "column",
          gap: 16,
        }}
      >
        <img src="/logo.png" alt="" width={56} height={56} style={{ objectFit: "contain", animation: "spin 1.1s linear infinite" }} />
        <div style={{ fontSize: 15, fontWeight: 800, color: JM.p, letterSpacing: "-0.02em" }}>JM Tally</div>
        <div style={{ fontSize: 12, color: "#64748b", fontWeight: 600 }}>Loading books…</div>
      </div>
    )

  const S = {
    wrap: { display: "flex", height: "100vh", overflow: "hidden", background: SKY.page, fontFamily: "'DM Sans',system-ui,sans-serif", fontSize: 13, color: SKY.text },
    sb: { width: 224, background: SKY.surface2, borderRight: `1px solid ${SKY.borderHi}`, display: "flex", flexDirection: "column", flexShrink: 0 },
    main: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 },
    bar: {
      background: SKY.surface,
      borderBottom: `1px solid ${SKY.borderHi}`,
      padding: "14px 20px 16px",
      display: "flex",
      flexDirection: "column",
      alignItems: "stretch",
      gap: 14,
      flexShrink: 0,
      boxShadow: "0 1px 0 rgba(107,122,255,.06)",
    },
    cnt: { flex: 1, overflowY: "auto", padding: 18, background: SKY.page },
    g4: { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 11, marginBottom: 13 },
    g3: { display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 11, marginBottom: 13 },
    g2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 13, marginBottom: 13 },
    card: { background: SKY.surface, border: `1px solid ${SKY.border}`, borderRadius: 12, padding: 16, marginBottom: 13, boxShadow: "0 1px 3px rgba(107,122,255,.06)" },
    btn: { background: JM.p, border: "none", borderRadius: 8, padding: "6px 13px", fontSize: 12, fontWeight: 700, color: "#fff", cursor: "pointer" },
    btnO: { background: "transparent", border: `1px solid ${SKY.borderHi}`, borderRadius: 8, padding: "6px 11px", fontSize: 12, fontWeight: 600, color: SKY.text2, cursor: "pointer" },
    sel: { ...IS, height: 33, cursor: "pointer" },
    tab: a => ({
      padding: "5px 13px",
      borderRadius: 7,
      fontSize: 11.5,
      fontWeight: 600,
      cursor: "pointer",
      color: a ? JM.p : SKY.muted,
      background: a ? SKY.surface2 : "transparent",
      border: "none",
    }),
    tabs: { display: "flex", gap: 2, background: SKY.surface2, borderRadius: 8, padding: 3, marginBottom: 14, width: "fit-content", border: `1px solid ${SKY.border}` },
  }

  const hdrInput = {
    background: SKY.surface,
    border: `1px solid ${SKY.borderHi}`,
    borderRadius: 8,
    color: SKY.text,
    fontSize: 11,
    height: 32,
    padding: "0 10px",
    outline: "none",
    fontFamily: "inherit",
    boxSizing: "border-box",
  }
  const hdrGroup = {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
    padding: "8px 12px",
    background: SKY.surface2,
    border: `1px solid ${SKY.border}`,
    borderRadius: 10,
  }
  const hdrLbl = {
    fontSize: 9,
    fontWeight: 800,
    color: SKY.text2,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    whiteSpace: "nowrap",
  }

  const pages = {dash:"Dashboard",txn:"Transactions",inv:"Invoices & Bills",led:"General Ledger",coa:"Chart of Accounts",gst:"GST Compliance",pay:"Payroll & TDS",stock:"Inventory",rec:"Reconciliation",rep:"Reports & P&L",bulk:"Bulk Upload",ai:"AI Assistant"}
  const nav = [{g:"Overview",n:[["⊞","dash"],["⇄","txn"],["≡","inv"],["▤","led"]]},{g:"Finance",n:[["◈","gst"],["⊙","pay"],["▥","coa"],["▣","stock"],["⊗","rec"]]},{g:"Intelligence",n:[["⟂","rep"],["↑","bulk"],["✦","ai"]]}]

  // Mini bar chart
  const BarChart = ({data,h=118}) => {
    const mx = Math.max(1, ...data.map(d => Math.max(d.cr, d.dr)))
    return <div style={{display:"flex",gap:2,alignItems:"flex-end",height:h,paddingTop:8}}>
      {data.map((d,i)=>(
        <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center"}}>
          <div style={{display:"flex",gap:1,alignItems:"flex-end",height:h-20}}>
            <div style={{width:8,borderRadius:"3px 3px 0 0",background:"#10b981",height:Math.round(d.cr/mx*(h-20))||2}}/>
            <div style={{width:8,borderRadius:"3px 3px 0 0",background:"#f43f5e",height:Math.round(d.dr/mx*(h-20))||2}}/>
          </div>
          <div style={{fontSize:8,color:"#475569",marginTop:3,textAlign:"center"}}>{d.m}</div>
        </div>
      ))}
    </div>
  }

  // Pie chart
  const PieChart = ({data,size=108}) => {
    const total = data.reduce((s,d)=>s+d.v,0)
    if (total <= 0)
      return <div style={{color:"#64748b",fontSize:11,padding:12}}>No revenue categories to chart yet.</div>
    let start = -Math.PI/2
    const paths = data.map(d=>{
      const a=d.v/total*Math.PI*2, end=start+a
      const x1=50*Math.cos(start),y1=50*Math.sin(start),x2=50*Math.cos(end),y2=50*Math.sin(end)
      const lg=a>Math.PI?1:0
      const path=`M0 0 L${x1} ${y1} A50 50 0 ${lg} 1 ${x2} ${y2} Z`
      start=end
      return {path,c:d.c,n:d.n,pct:Math.round(d.v/total*100)}
    })
    return <div style={{display:"flex",gap:14,alignItems:"center"}}>
      <svg width={size} height={size} viewBox="-55 -55 110 110" style={{flexShrink:0}}>
        {paths.map((p, i) => (
          <path key={i} d={p.path} fill={p.c} stroke={SKY.borderHi} strokeWidth={1.5} />
        ))}
      </svg>
      <div style={{display:"flex",flexDirection:"column",gap:5}}>
        {paths.map((p,i)=><div key={i} style={{display:"flex",alignItems:"center",gap:7,fontSize:11}}>
          <div style={{width:8,height:8,borderRadius:"50%",background:p.c,flexShrink:0}}/>
          <span style={{color:"#94a3b8"}}>{p.n}</span>
          <span style={{fontWeight:700,color:"#0c4a6e",fontFamily:"monospace"}}>{p.pct}%</span>
        </div>)}
      </div>
    </div>
  }

  // Page renderers
  const Dash = () => {
    const periodActive = !!(repFy || repMonthKey || repFromIso || repToIso)
    const topRev = revenueCats[0]
    const topName = topRev ? String(topRev[0]).replace(/^Revenue -\s*/, "") : "—"
    const topAmt = topRev ? topRev[1] : 0
    const topPct = revCatTotal > 0 && topRev ? Math.round((topRev[1] / revCatTotal) * 1000) / 10 : 0
    const piePalette = ["#6B7AFF", "#10b981", "#f59e0b", "#5563E8", "#64748b"]
    const pieTop = revenueCats.slice(0, 4).map(([n, v], i) => ({
      n: String(n).replace(/^Revenue -\s*/, "") || n,
      v,
      c: piePalette[i % piePalette.length],
    }))
    const pieSumTop = pieTop.reduce((s, p) => s + p.v, 0)
    if (revCatTotal > pieSumTop) pieTop.push({ n: "Others", v: Math.round((revCatTotal - pieSumTop) * 100) / 100, c: "#64748b" })
    const drTotal = drByCat.reduce((s, [, v]) => s + v, 0) || 1
    const topExpRows = drByCat.slice(0, 5)
    const crN = reportLedger.filter(t => t.drCr === "CR").length
    const drN = reportLedger.filter(t => t.drCr === "DR").length
    return (
    <div>
      {periodActive && (
        <div style={{ fontSize: 11, color: "#0369a1", marginBottom: 12, padding: "8px 11px", background: "rgba(107,122,255,.1)", borderRadius: 8, border: "1px solid rgba(107,122,255,.25)" }}>
          Period filter active — figures below are for the selected FY / month / dates. Sidebar bank balance is still your <strong>full</strong> book closing.
        </div>
      )}
      <div style={S.g4}>
        <Stat label="Total receipts (CR)" value={"₹"+inr0(reportStats.cr)} sub={periodActive?"Filtered period":"All dates in book"} color="#10b981" icon="💰"/>
        <Stat label="Total payments (DR)" value={"₹"+inr0(reportStats.dr)} sub={periodActive?"Filtered period":"All dates in book"} color="#f43f5e" icon="📤"/>
        <Stat label="Booked CR − DR" value={"₹"+inr0(reportStats.flowNet)} sub="Sum of txn amounts · may differ from bank column" color="#6B7AFF" icon="📈"/>
        <Stat label="Transactions" value={String(reportStats.count)} sub={"In scope · CR:"+crN+" · DR:"+drN} icon="⇄"/>
      </div>
      <div style={S.g3}>
        <Stat label="Top revenue category" value={topName} sub={topRev ? "₹"+inr0(topAmt)+" · "+topPct+"% of Revenue-* credits" : "Add Revenue-* credits"} color="#5563E8" icon="🤝"/>
        <Stat
          label={periodActive ? "Period closing (bank col.)" : "Bank closing (full book)"}
          value={"₹" + inr0(periodActive ? reportStats.balance : stats.balance)}
          sub={activeCompany?.bankAccountLabel?.slice(0, 36) || "Primary bank · set label in Companies"}
          color="#6B7AFF"
          icon="🏦"
        />
        <Stat label="Director payment (DR)" value={"₹"+inr0(dirDrawTotal)} sub="Category: Director Payment" color="#f43f5e" icon="👤"/>
      </div>
      <div style={S.g2}>
        <div style={{...S.card,marginBottom:0}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            <div style={{fontSize:12,fontWeight:700}}>📊 Monthly Cash Flow</div>
            <button onClick={()=>setPage("rep")} style={{...S.btnO,fontSize:10,padding:"4px 9px"}}>Full Report →</button>
          </div>
          <BarChart data={monthlyFlow.length ? monthlyFlow : [{ m: "—", cr: 0, dr: 0 }]}/>
          <div style={{display:"flex",justifyContent:"center",gap:14,fontSize:10,color:"#64748b",marginTop:8}}>
            <span><span style={{display:"inline-block",width:8,height:8,background:"#10b981",borderRadius:2,marginRight:4,verticalAlign:"middle"}}/>Receipts</span>
            <span><span style={{display:"inline-block",width:8,height:8,background:"#f43f5e",borderRadius:2,marginRight:4,verticalAlign:"middle"}}/>Payments</span>
          </div>
        </div>
        <div style={{...S.card,marginBottom:0}}>
          <div style={{fontSize:12,fontWeight:700,marginBottom:12}}>🥧 Revenue by category</div>
          <PieChart data={pieTop.length ? pieTop : [{ n: "—", v: 0, c: "#64748b" }]}/>
        </div>
      </div>
      <div style={S.g2}>
        <div style={{...S.card,marginBottom:0}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <div style={{fontSize:12,fontWeight:700}}>⇄ Recent Transactions</div>
            <button onClick={()=>setPage("txn")} style={{...S.btnO,fontSize:10,padding:"4px 9px"}}>View All →</button>
          </div>
          <Tbl cols={[{h:"Date",k:"date"},{h:"Particulars",cell:r=><span style={{fontSize:11,color:"#94a3b8",opacity:r.void?0.45:1}}>{r.particulars.substring(0,34)}{r.void?" (void)":""}</span>},{h:"Category",cell:r=><Chip cat={r.category}/>},{h:"Amount",r:true,cell:r=><span style={{color:r.drCr==="CR"?"#10b981":"#f43f5e",fontFamily:"monospace",fontWeight:700,fontSize:11,opacity:r.void?.5:1}}>{r.drCr==="CR"?"+":"-"}₹{inr(r.amount)}</span>}]} rows={txns.filter(t=>!t.void).slice(-6).reverse()}/>
        </div>
        <div style={{...S.card,marginBottom:0}}>
          <div style={{fontSize:12,fontWeight:700,marginBottom:12}}>📊 Top debits by category</div>
          {topExpRows.length === 0 ? (
            <div style={{color:"#64748b",fontSize:11}}>No payments yet.</div>
          ) : (
            topExpRows.map(([n, v], idx) => {
              const pct = Math.round((v / drTotal) * 1000) / 10
              const c = ["#f59e0b", "#f43f5e", "#64748b", "#06b6d4", "#5563E8"][idx % 5]
              return (
                <div key={n} style={{marginBottom:9}}>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:11,marginBottom:2}}>
                    <span style={{color:"#94a3b8"}}>{n}</span>
                    <span style={{fontWeight:700,fontFamily:"monospace"}}>
                      ₹{inr0(v)} <span style={{color:"#475569",fontWeight:400}}>({pct}%)</span>
                    </span>
                  </div>
                  <div style={{ height: 4, background: "#e0f2fe", borderRadius: 10, overflow: "hidden" }}>
                    <div style={{height:"100%",background:c,borderRadius:10,width:Math.min(100,pct)+"%"}}/>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
    )
  }

  const Txn = () => {
    const cr=filtered.filter(t=>t.drCr==="CR").reduce((s,t)=>s+t.amount,0)
    const dr=filtered.filter(t=>t.drCr==="DR").reduce((s,t)=>s+t.amount,0)
    return (
      <div>
        <div style={S.g4}>
          <Stat label="Credits" value={"₹"+inr0(cr)} color="#10b981"/>
          <Stat label="Debits" value={"₹"+inr0(dr)} color="#f43f5e"/>
          <Stat label="Net" value={"₹"+inr0(Math.abs(cr-dr))} color={cr>=dr?"#10b981":"#f43f5e"}/>
          <Stat label="Count" value={String(filtered.length)} color="#94a3b8"/>
        </div>
        {repFy ? (
          <div style={{ fontSize: 11, color: "#0369a1", marginBottom: 10, padding: "6px 10px", background: "rgba(107,122,255,.08)", borderRadius: 8 }}>
            List filtered to <strong>{formatFyLabel(repFy)}</strong>. Use top bar <strong>Financial year</strong> → <strong>All FYs</strong> to show every year.
          </div>
        ) : null}
        <div style={{display:"flex",gap:7,flexWrap:"wrap",alignItems:"center",marginBottom:13}}>
          <label style={{fontSize:11,color:"#94a3b8",display:"flex",alignItems:"center",gap:6}}><input type="checkbox" checked={showVoid} onChange={e=>setShowVoid(e.target.checked)}/> Show voided</label>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="🔍 Search..." style={{...IS,width:200,height:32}}/>
          <select value={fDC} onChange={e=>setFDC(e.target.value)} style={{...S.sel,width:110}}><option value="">All Types</option><option value="CR">Credits</option><option value="DR">Debits</option></select>
          <select value={fCat} onChange={e=>setFCat(e.target.value)} style={{...S.sel,width:170}}><option value="">All Categories</option>{CATS.map(c=><option key={c} value={c}>{c}</option>)}</select>
          <button type="button" onClick={()=>setModal("txn")} disabled={acctRole==="Viewer"} style={{...S.btn,fontSize:11,padding:"5px 11px",opacity:acctRole==="Viewer"?0.45:1,cursor:acctRole==="Viewer"?"default":"pointer"}}>{acctRole==="Viewer"?"View-only":"+ Add"}</button>
          <button type="button" onClick={()=>{const h="Date,Particulars,Category,Type,Amount,Balance,FY\n"+txns.map(t=>[t.date,'"'+t.particulars.replace(/"/g,"'")+'"',t.category,t.drCr,t.amount,t.balance,t.fy].join(",")).join("\n");const b=new Blob([h],{type:"text/csv"});const a=document.createElement("a");a.href=URL.createObjectURL(b);a.download="jm_tally_txns.csv";a.click()}} style={{...S.btnO,fontSize:11,padding:"5px 11px"}}>⬇ CSV</button>
        </div>
        <Tbl cols={[
          {h:"#",k:"id",cell:r=><span style={{color:"#475569",fontSize:11}}>{r.id}</span>},
          {h:"Date",k:"date"},
          {h:"Particulars",cell:r=><span style={{fontSize:11,opacity:r.void?0.55:1}} title={r.void?(r.voidReason?`${r.particulars}\n\nVoid reason: ${r.voidReason}`:r.particulars):r.particulars}>{r.particulars.substring(0,46)}{r.void?" (void)":""}</span>},
          {h:"Category",cell:r=><Chip cat={r.category}/>},
          {h:"Type",cell:r=><span style={{...pillStyle(r.drCr==="CR"?"Revenue":"Director Payment",r.drCr),fontSize:9.5}}>{r.drCr}</span>},
          {h:"Amount",r:true,cell:r=><span style={{color:r.drCr==="CR"?"#10b981":"#f43f5e",fontFamily:"monospace",fontWeight:700}}>{r.drCr==="CR"?"+":"-"}₹{inr(r.amount)}</span>},
          {h:"Balance",r:true,cell:r=><span style={{color:"#6B7AFF",fontFamily:"monospace"}}>₹{inr(r.balance)}</span>},
          {h:"FY",cell:r=><Chip cat="Bank Charges" label={r.fy}/>},
          {h:"JE",cell:r=><span style={{fontSize:10,color:r.journalLines?"#10b981":"#64748b"}} title={r.journalLines?r.journalLines.map(l=>`${l.account} Dr ${l.debit||""} Cr ${l.credit||""}`).join(" · "):""}>{r.journalLines?r.journalLines.length+"L ✓":"—"}</span>},
          {h:"",cell:r=><button title="Void (no hard delete)" disabled={acctRole==="Viewer"||r.void} onClick={()=>openVoidConfirm(r.id)} style={{background:"none",border:"none",cursor:r.void||acctRole==="Viewer"?"default":"pointer",color:r.void?"#475569":"#f59e0b",fontSize:12,padding:"2px 5px"}}>{r.void?"✕":"⊘"}</button>},
        ]} rows={filtered} empty="No transactions match filters"/>
      </div>
    )
  }

  const Inv = () => {
    const rev = reportLedger.filter(t => t.drCr === "CR" && t.category.startsWith("Revenue"))
    const oth = reportLedger.filter(t => t.drCr === "CR" && !t.category.startsWith("Revenue"))
    const bankCols = [
      { h: "Date", k: "date" },
      { h: "Particulars", cell: r => <span style={{ fontSize: 11, color: "#94a3b8" }}>{r.particulars.substring(0, 44)}</span> },
      { h: "Category", cell: r => <Chip cat={r.category} /> },
      { h: "Amount", r: true, cell: r => <span style={{ color: "#10b981", fontFamily: "monospace", fontWeight: 700 }}>₹{inr(r.amount)}</span> },
      { h: "FY", cell: r => <Chip cat="Bank Charges" label={r.fy} /> },
    ]
    const outstand = invoices.reduce((s, i) => s + Math.max(0, invoiceBalance(i)), 0)
    const overdueN = invoices.filter(i => invoiceUiStatus(i) === "overdue").length
    const paidN = invoices.filter(i => invoiceUiStatus(i) === "paid").length
    const gstOpen = invoices.reduce((s, i) => {
      const bal = invoiceBalance(i)
      if (bal <= 0.01) return s
      const ratio = bal / (Number(i.total) || 1)
      return s + (Number(i.cgst) + Number(i.sgst) + Number(i.igst)) * ratio
    }, 0)
    const filteredInv = [...invoices]
      .filter(inv => {
        const u = invoiceUiStatus(inv)
        if (invListFilter === "all") return true
        if (invListFilter === "paid") return u === "paid"
        if (invListFilter === "overdue") return u === "overdue"
        if (invListFilter === "open") return u !== "paid"
        return true
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date) || b.id - a.id)
    const invCols = [
      { h: "Invoice #", k: "num" },
      { h: "Date", k: "date" },
      { h: "Due", k: "dueDate" },
      { h: "Client", cell: r => <span style={{ fontSize: 11 }}>{String(r.client).slice(0, 28)}</span> },
      { h: "Taxable", r: true, cell: r => <span style={{ fontFamily: "monospace", fontSize: 11 }}>₹{inr(r.taxable)}</span> },
      {
        h: "GST",
        r: true,
        cell: r => (
          <span style={{ fontFamily: "monospace", fontSize: 10, color: "#94a3b8" }}>
            {r.igst > 0 ? `IGST ₹${inr(r.igst)}` : `₹${inr(r.cgst)}+${inr(r.sgst)}`}
          </span>
        ),
      },
      { h: "Total", r: true, cell: r => <span style={{ fontFamily: "monospace", fontWeight: 700 }}>₹{inr(r.total)}</span> },
      {
        h: "Bank / TDS",
        r: true,
        cell: r => {
          const b = Number(r.paidBankTotal != null ? r.paidBankTotal : r.paidAmount) || 0
          const td = Number(r.paidTdsTotal) || 0
          return (
            <span style={{ fontFamily: "monospace", fontSize: 10, color: "#94a3b8", lineHeight: 1.35 }}>
              <span style={{ color: "#0c4a6e" }}>B ₹{inr(b)}</span>
              {td > 0 ? <span style={{ display: "block", color: "#0369a1" }}>TDS ₹{inr(td)}</span> : null}
            </span>
          )
        },
      },
      { h: "Due (₹)", r: true, cell: r => <span style={{ fontFamily: "monospace", color: invoiceBalance(r) > 0 ? "#f59e0b" : "#64748b" }}>₹{inr(invoiceBalance(r))}</span> },
      {
        h: "Status",
        cell: r => {
          const u = invoiceUiStatus(r)
          const cat = u === "paid" ? "Revenue" : u === "overdue" ? "Director Payment" : u === "partial" ? "Bank Charges" : "Misc Expense"
          return <Chip cat={cat} label={u} />
        },
      },
      {
        h: "",
        cell: r => (
          <span style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
            {invoiceUiStatus(r) !== "paid" && (
              <>
                <button
                  type="button"
                  disabled={acctRole === "Viewer"}
                  onClick={() => markInvoicePaidFull(r.id)}
                  style={{ background: "rgba(16,185,129,.2)", border: "1px solid rgba(16,185,129,.4)", borderRadius: 6, padding: "2px 7px", fontSize: 10, color: "#6ee7b7", cursor: acctRole === "Viewer" ? "default" : "pointer" }}
                >
                  Paid
                </button>
                <button
                  type="button"
                  disabled={acctRole === "Viewer"}
                  onClick={() => {
                    setInvPayId(r.id)
                    setInvPayAmt(String(invoiceBalance(r)))
                    setInvPayTds("")
                  }}
                  style={{ background: "transparent", border: "1px solid #bae6fd", borderRadius: 6, padding: "2px 7px", fontSize: 10, color: "#94a3b8", cursor: acctRole === "Viewer" ? "default" : "pointer" }}
                >
                  Pay…
                </button>
              </>
            )}
            <button
              type="button"
              disabled={acctRole === "Viewer"}
              onClick={() => openInvoiceDeleteConfirm(r.id)}
              title="Remove from register"
              style={{ background: "none", border: "none", fontSize: 10, color: "#f43f5e", cursor: acctRole === "Viewer" ? "default" : "pointer" }}
            >
              ✕
            </button>
          </span>
        ),
      },
    ]
    return (
      <div>
        <div style={S.tabs}>
          {[
            ["sales", "Sales invoices"],
            ["bank", "Bank credits"],
          ].map(([k, l]) => (
            <button key={k} type="button" onClick={() => setInvView(k)} style={S.tab(invView === k)}>
              {l}
            </button>
          ))}
        </div>
        {invView === "sales" ? (
          <>
            <div style={S.g4}>
              <Stat label="Outstanding (invoices)" value={"₹" + inr0(outstand)} sub={String(invoices.length) + " issued"} color="#f59e0b" />
              <Stat label="Overdue" value={String(overdueN)} sub="Past due date & unpaid" color={overdueN ? "#f43f5e" : "#94a3b8"} />
              <Stat label="GST on open balance (est.)" value={"₹" + inr0(gstOpen)} sub="CGST+SGST or IGST" color="#5563E8" />
              <Stat label="Fully paid" value={String(paidN)} sub="Invoices settled" color="#10b981" />
            </div>
            <div style={{ background: "rgba(107,122,255,.08)", border: "1px solid rgba(107,122,255,.22)", borderRadius: 10, padding: "10px 14px", marginBottom: 13, fontSize: 11, color: "#0369a1", lineHeight: 1.55 }}>
              <strong>Sales register</strong> — Taxable + GST (intra-state CGST+SGST or inter-state IGST). <strong>Pay…</strong>: enter <strong>bank receipt</strong> and optional <strong>TDS</strong> withheld by the client — both count toward clearing the invoice (₹ in bank + ₹ TDS = settlement). Use <strong>Paid</strong> only when the full balance arrived in the bank with <strong>no</strong> TDS on that bill. Ledger: post the <strong>actual credit</strong> in Transactions; TDS is reconciled via Form 26AS / TDS certificates.
            </div>
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
              <button type="button" onClick={openCreateInvoiceModal} style={{ ...S.btn, fontSize: 11, padding: "5px 11px" }}>
                + New invoice
              </button>
              <button type="button" onClick={exportInvoicesCsv} disabled={!invoices.length} style={{ ...S.btnO, fontSize: 11, padding: "5px 11px", opacity: invoices.length ? 1 : 0.45 }}>
                ⬇ Export CSV
              </button>
              <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                {[
                  ["open", "Open"],
                  ["overdue", "Overdue"],
                  ["paid", "Paid"],
                  ["all", "All"],
                ].map(([k, l]) => (
                  <button key={k} type="button" onClick={() => setInvListFilter(k)} style={{ ...S.tab(invListFilter === k), padding: "4px 10px", fontSize: 10 }}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
            <Tbl cols={invCols} rows={filteredInv} empty="No invoices — create one or change the filter above." />
          </>
        ) : (
          <>
            <div style={S.g4}>
              <Stat label="Revenue credits" value={"₹" + inr0(rev.reduce((s, t) => s + t.amount, 0))} sub={String(rev.length) + " lines"} color="#10b981" />
              <Stat label="Capital & other credits" value={"₹" + inr0(oth.reduce((s, t) => s + t.amount, 0))} sub={String(oth.length) + " lines"} color="#f59e0b" />
              <Stat label="IT refund (CR)" value={"₹" + inr0(oth.filter(t => t.category === "Income Tax Refund").reduce((s, t) => s + t.amount, 0))} color="#10b981" />
              <Stat label="NEFT return (CR)" value={"₹" + inr0(oth.filter(t => t.category === "NEFT Return").reduce((s, t) => s + t.amount, 0))} color="#94a3b8" />
            </div>
            <div style={S.tabs}>
              {[
                ["rev", "Revenue credits"],
                ["oth", "Capital & other"],
              ].map(([k, l]) => (
                <button key={k} type="button" onClick={() => setITab(k)} style={S.tab(iTab === k)}>
                  {l}
                </button>
              ))}
            </div>
            <Tbl cols={bankCols} rows={iTab === "rev" ? rev : oth} empty="No rows for this filter." />
          </>
        )}
      </div>
    )
  }

  const Led = () => {
    const act = reportLedger
    let data = act
    if(ledAcc.includes("Salary")) data=act.filter(t=>t.category.startsWith("Salary")&&t.drCr==="DR")
    else if(ledAcc.includes("Director")) data=act.filter(t=>t.category==="Director Payment"&&t.drCr==="DR")
    else if(ledAcc.includes("Revenue")) data=act.filter(t=>t.category.startsWith("Revenue")&&t.drCr==="CR")
    else if(ledAcc.includes("Vendor")) data=act.filter(t=>(t.category.startsWith("Vendor")||t.category.startsWith("Recruitment"))&&t.drCr==="DR")
    else if(ledAcc.includes("Capital")) data=act.filter(t=>t.category.startsWith("Capital")&&t.drCr==="CR")
    const tDr=data.filter(t=>t.drCr==="DR").reduce((s,t)=>s+t.amount,0)
    const tCr=data.filter(t=>t.drCr==="CR").reduce((s,t)=>s+t.amount,0)
    return (
      <div>
        <div style={{display:"flex",gap:7,marginBottom:13}}>
          <select value={ledAcc} onChange={e=>setLedAcc(e.target.value)} style={{...S.sel,width:220}}>
            {["Primary bank account","Service revenue","Salaries & wages","Directors remuneration","Vendor payable","Capital"].map(a=><option key={a}>{a}</option>)}
          </select>
          <input type="date" defaultValue="2025-01-01" style={{...IS,width:130,height:32}}/>
          <input type="date" defaultValue="2026-03-31" style={{...IS,width:130,height:32}}/>
        </div>
        <div style={{background:"#ffffff",border:"1px solid #bae6fd",borderRadius:10,overflow:"hidden"}}>
          <div style={{display:"grid",gridTemplateColumns:"88px 1fr 105px 105px 120px",gap:8,padding:"8px 13px",background:"#ffffff",fontSize:10,fontWeight:700,color:"#64748b",borderBottom:"1px solid #bae6fd",textTransform:"uppercase",letterSpacing:".4px"}}>
            <div>Date</div><div>Narration</div><div>Debit (₹)</div><div>Credit (₹)</div><div>Balance (₹)</div>
          </div>
          {data.slice(-80).map((t,i)=>(
            <div key={i} style={{display:"grid",gridTemplateColumns:"88px 1fr 105px 105px 120px",gap:8,padding:"7px 13px",borderBottom:"1px solid #e0f2fe",fontSize:11.5}}>
              <div style={{color:"#64748b"}}>{t.date}</div>
              <div style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontSize:11}}>{t.particulars.substring(0,50)}</div>
              <div style={{color:t.drCr==="DR"?"#f43f5e":"#bae6fd",fontFamily:"monospace",fontWeight:t.drCr==="DR"?700:400}}>{t.drCr==="DR"?"₹"+inr(t.amount):"—"}</div>
              <div style={{color:t.drCr==="CR"?"#10b981":"#bae6fd",fontFamily:"monospace",fontWeight:t.drCr==="CR"?700:400}}>{t.drCr==="CR"?"₹"+inr(t.amount):"—"}</div>
              <div style={{color:"#6B7AFF",fontFamily:"monospace",fontWeight:600}}>₹{inr(t.balance)}</div>
            </div>
          ))}
          <div style={{display:"grid",gridTemplateColumns:"88px 1fr 105px 105px 120px",gap:8,padding:"8px 13px",background:"#ffffff",fontSize:12,fontWeight:700,borderTop:"1px solid #bae6fd"}}>
            <div>TOTAL</div><div></div>
            <div style={{color:"#f43f5e",fontFamily:"monospace"}}>₹{inr(tDr)}</div>
            <div style={{color:"#10b981",fontFamily:"monospace"}}>₹{inr(tCr)}</div>
            <div style={{color:"#6B7AFF",fontFamily:"monospace"}}>₹{inr(Math.abs(tCr-tDr))} {tCr>=tDr?"Cr":"Dr"}</div>
          </div>
        </div>
      </div>
    )
  }

  const Coa = () => {
    const [coaSearch, setCoaSearch] = useState("")
    const [coaHideZero, setCoaHideZero] = useState(false)
    const { merged, orphans, tDr, tCr } = useMemo(() => coaRowsWithBalances(reportLedger), [reportLedger])
    const flatWithBalances = useMemo(() => [...merged, ...orphans], [merged, orphans])
    const coaGroupOrder = [
      "Assets",
      "Liabilities",
      "Equity",
      "Income",
      "Expenses — Direct & COGS",
      "Expenses — People",
      "Expenses — Operations",
      "Expenses — Finance & Tax",
      "Journal only (not on chart)",
    ]
    const allCoaKeys = [...Object.keys(CHART_OF_ACCOUNTS), "Journal only (not on chart)"]
    const orderedGroups = [...new Set([...coaGroupOrder.filter(k => allCoaKeys.includes(k)), ...allCoaKeys.filter(k => !coaGroupOrder.includes(k))])]
    const q = coaSearch.trim().toLowerCase()
    const filteredFlat = useMemo(() => {
      let f = flatWithBalances
      if (coaHideZero) f = f.filter(r => Math.abs(r.debit) > 0.005 || Math.abs(r.credit) > 0.005)
      if (!q) return f
      return f.filter(
        r =>
          String(r.code).includes(q) ||
          String(r.name).toLowerCase().includes(q) ||
          String(r.type).toLowerCase().includes(q) ||
          String(r.group).toLowerCase().includes(q)
      )
    }, [flatWithBalances, q, coaHideZero])
    const catsForAccount = accName =>
      CATS.filter(c => categoryToNominalAccount(c) === accName).join(" · ") || "—"
    const byGroupFiltered = useMemo(() => {
      const m = {}
      for (const r of filteredFlat) {
        if (!m[r.group]) m[r.group] = []
        m[r.group].push(r)
      }
      for (const k of Object.keys(m)) m[k].sort((a, b) => String(a.code).localeCompare(String(b.code)) || a.name.localeCompare(b.name))
      return m
    }, [filteredFlat])
    const typeCount = useMemo(() => {
      const n = { Asset: 0, Liability: 0, Equity: 0, Income: 0, Expense: 0, Unmapped: 0 }
      for (const r of merged) {
        const t = r.type
        if (t in n) n[t]++
      }
      n.Unmapped = orphans.length
      return n
    }, [merged, orphans])
    const fmtDc = v => (Math.abs(v) < 0.005 ? "—" : `₹${inr(v)}`)
    const fmtNet = netDr => {
      if (Math.abs(netDr) < 0.005) return "—"
      return netDr >= 0 ? `Dr ₹${inr(netDr)}` : `Cr ₹${inr(-netDr)}`
    }
    const exportCoaCsv = () => {
      const head =
        "Group,Code,Account,Type,Normal balance,Debit,Credit,Net Dr(+)/Cr(-),Maps from categories\n"
      const body = flatWithBalances
        .map(
          r =>
            `"${r.group}",${r.code},"${String(r.name).replace(/"/g, '""')}",${r.type},${r.normal || "—"},${r.debit},${r.credit},${r.netDr},"${catsForAccount(r.name).replace(/"/g, '""')}"`
        )
        .join("\n")
      const b = new Blob([head + body], { type: "text/csv" })
      const a = document.createElement("a")
      a.href = URL.createObjectURL(b)
      a.download = "jm_tally_chart_of_accounts.csv"
      a.click()
      toast_("Chart exported", "#10b981")
    }
    const gridCols = "56px minmax(100px,1.1fr) 58px 52px 78px 78px 92px minmax(88px,1fr)"
    const tbDiff = Math.round((tDr - tCr) * 100) / 100
    return (
      <div>
        <div style={{ ...S.card, marginBottom: 13 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: "#0c4a6e", marginBottom: 8 }}>Chart of Accounts</div>
          <div style={{ fontSize: 11.5, color: "#94a3b8", lineHeight: 1.65, marginBottom: 12 }}>
            Full ledger for <strong style={{ color: JM.p }}>{activeCompany?.legalName || activeCompany?.name || "your company"}</strong> — aligned with Indian GST (output / input split), TDS, payroll, and bank-led double-entry. Each transaction category maps to one <strong>nominal</strong> account; journals pair that with your <strong style={{ color: JM.p2 }}>primary bank</strong> nominal. Contra accounts (e.g. accumulated depreciation) have natural <strong>Credit</strong> balance.
            <br />
            <span style={{ color: "#64748b" }}>
              <strong style={{ color: "#94a3b8" }}>Debit / Credit / Net</strong> use the same period as Reports (FY, month, or custom dates).
            </span>
          </div>
          <div style={S.g4}>
            <Stat label="Asset accounts" value={String(typeCount.Asset)} color="#6B7AFF" />
            <Stat label="Liabilities" value={String(typeCount.Liability)} color="#f43f5e" />
            <Stat label="Equity" value={String(typeCount.Equity)} color="#5563E8" />
            <Stat label="Income / Expense" value={`${typeCount.Income} / ${typeCount.Expense}`} sub="P&amp;L heads" color="#10b981" />
          </div>
          {typeCount.Unmapped > 0 && (
            <div style={{ fontSize: 10.5, color: "#fbbf24", marginTop: 8 }}>
              {typeCount.Unmapped} journal account{typeCount.Unmapped === 1 ? "" : "s"} not on the static chart — see group <strong>Journal only (not on chart)</strong>.
            </div>
          )}
          <div style={{ fontSize: 10.5, color: "#94a3b8", marginTop: 10, fontFamily: "monospace" }}>
            Period nominal TB: Dr ₹{inr(tDr)} · Cr ₹{inr(tCr)}
            {Math.abs(tbDiff) > 0.02 && (
              <span style={{ color: "#f87171", marginLeft: 6 }}>· Unbalanced by ₹{inr(Math.abs(tbDiff))}</span>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12, alignItems: "center" }}>
            <input
              value={coaSearch}
              onChange={e => setCoaSearch(e.target.value)}
              placeholder="Search code, name, group…"
              style={{ ...IS, width: 240, height: 34 }}
            />
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#94a3b8", cursor: "pointer" }}>
              <input type="checkbox" checked={coaHideZero} onChange={e => setCoaHideZero(e.target.checked)} />
              Hide zero movement
            </label>
            <button type="button" onClick={exportCoaCsv} style={{ ...S.btnO, fontSize: 11, padding: "6px 12px" }}>
              ⬇ Export COA (CSV)
            </button>
            <span style={{ fontSize: 10, color: "#64748b" }}>
              {filteredFlat.length} of {flatWithBalances.length} rows
            </span>
          </div>
        </div>
        {orderedGroups.map(group => {
          const rows = byGroupFiltered[group]
          if (!rows?.length) return null
          return (
            <div key={group} style={{ ...S.card, marginBottom: 11, overflowX: "auto" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#0369a1", textTransform: "uppercase", letterSpacing: ".55px", marginBottom: 10 }}>{group}</div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: gridCols,
                  gap: 8,
                  fontSize: 10,
                  fontWeight: 700,
                  color: "#64748b",
                  padding: "0 2px 6px",
                  borderBottom: "1px solid #bae6fd",
                  minWidth: 720,
                }}
              >
                <div>Code</div>
                <div>Account</div>
                <div>Type</div>
                <div>Nrm</div>
                <div style={{ textAlign: "right" }}>Debit</div>
                <div style={{ textAlign: "right" }}>Credit</div>
                <div style={{ textAlign: "right" }}>Net</div>
                <div>Maps from (categories)</div>
              </div>
              {rows.map(r => (
                <div
                  key={r.code + r.name}
                  style={{
                    display: "grid",
                    gridTemplateColumns: gridCols,
                    gap: 8,
                    alignItems: "start",
                    padding: "7px 2px",
                    borderBottom: "1px solid #e0f2fe",
                    fontSize: 11.5,
                    minWidth: 720,
                  }}
                >
                  <span style={{ fontFamily: "monospace", color: "#64748b" }}>{r.code}</span>
                  <span style={{ color: r.orphan ? "#fbbf24" : "#0c4a6e", fontWeight: 500 }}>{r.name}</span>
                  <span style={{ color: "#94a3b8", fontSize: 10 }}>{r.type}</span>
                  <span style={{ color: r.normal === "Credit" ? "#0369a1" : "#94a3b8", fontSize: 10 }}>{r.normal || "—"}</span>
                  <span style={{ fontFamily: "monospace", fontSize: 10.5, color: "#fca5a5", textAlign: "right" }}>{fmtDc(r.debit)}</span>
                  <span style={{ fontFamily: "monospace", fontSize: 10.5, color: "#86efac", textAlign: "right" }}>{fmtDc(r.credit)}</span>
                  <span
                    style={{
                      fontFamily: "monospace",
                      fontSize: 10.5,
                      textAlign: "right",
                      color: Math.abs(r.netDr) < 0.005 ? "#64748b" : r.netDr > 0 ? "#fca5a5" : "#86efac",
                    }}
                  >
                    {fmtNet(r.netDr)}
                  </span>
                  <span style={{ color: "#64748b", fontSize: 10, lineHeight: 1.45 }}>{catsForAccount(r.name)}</span>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    )
  }

  const GST = () => {
    const mon = {}
    reportLedger.forEach(t=>{ const p=t.date.split("/"),k=p[1]+"/"+p[2]; if(!mon[k])mon[k]={cr:0,label:p[1]+"/"+p[2]}; if(t.drCr==="CR")mon[k].cr+=t.amount })
    const rows = Object.entries(mon).sort(([a],[b])=>a.localeCompare(b)).filter(([,d])=>d.cr>100).map(([k,d])=>{
      const taxable=Math.round(d.cr/1.18),gst=Math.round(d.cr-taxable)
      return {month:d.label,rev:d.cr,taxable,gst,net:Math.max(0,gst-18),filed:k<"03/2026"}
    })
    const itVendorDr = reportLedger.filter(t=>t.drCr==="DR"&&t.category==="Vendor - IT Solutions")
    const itVendorGross = itVendorDr.reduce((s,t)=>s+t.amount,0)
    const itcItVendor = itVendorDr.reduce((s,t)=>s+gst18InclusiveSplit(t.amount).gst,0)
    const bankDr = reportLedger.filter(t=>t.drCr==="DR"&&t.category==="Bank Charges")
    const itcBank = bankDr.reduce((s,t)=>s+gst18InclusiveSplit(t.amount).gst,0)
    const totalItc = Math.round((itcItVendor+itcBank)*100)/100
    const itcCgstTot = Math.round((totalItc/2)*100)/100
    const itcSgstTot = Math.round((totalItc-itcCgstTot)*100)/100
    const outputGstEst = outputGstFromRev
    const netPayGst = Math.max(0,Math.round(outputGstEst-totalItc))
    const itcRowsIt = itVendorDr.map(t=>{
      const { taxable, gst, cgst, sgst } = gst18InclusiveSplit(t.amount)
      return { date:t.date, v:"IT Solutions", d:t.particulars.length>44?t.particulars.slice(0,42)+"…":t.particulars, a:"₹"+inr0(t.amount), tx:"₹"+inr0(taxable), g:"₹"+inr0(gst), cg:"₹"+inr0(cgst), sg:"₹"+inr0(sgst), sac:"99831x" }
    })
    const itcRowsBank = bankDr.map(t=>{
      const { taxable, gst, cgst, sgst } = gst18InclusiveSplit(t.amount)
      return { date:t.date, v:"Bank", d:t.particulars.length>44?t.particulars.slice(0,42)+"…":t.particulars, a:"₹"+inr0(t.amount), tx:"₹"+inr0(taxable), g:"₹"+inr0(gst), cg:"₹"+inr0(cgst), sg:"₹"+inr0(sgst), sac:"—" }
    })
    const itcRows = [...itcRowsIt,...itcRowsBank].sort((a,b)=>{ const pa=a.date.split("/"),pb=b.date.split("/"); return new Date(+pa[2],+pa[1]-1,+pa[0])-new Date(+pb[2],+pb[1]-1,+pb[0]) })
    const outCgst = Math.round(outputGstEst/2)
    const outSgst = outputGstEst-outCgst
    const netCgst = Math.max(0,outCgst-itcCgstTot)
    const netSgst = Math.max(0,outSgst-itcSgstTot)
    return (
      <div>
        <div style={S.g4}>
          <Stat label="Output GST (Est.)" value={"₹"+inr0(outputGstEst)} color="#6B7AFF"/>
          <Stat label="Input ITC (Est.)" value={"₹"+inr0(totalItc)} sub={"IT Solutions ₹"+inr0(itcItVendor)+" · Bank ₹"+inr0(itcBank)} color="#10b981"/>
          <Stat label="Net Payable (Est.)" value={"₹"+inr0(netPayGst)} sub="GSTR-3B due 20 Mar" color="#f43f5e"/>
          <Stat label="IT vendor paid (DR)" value={"₹"+inr0(itVendorGross)} sub={String(itVendorDr.length)+" payments · expense"} color="#5563E8"/>
        </div>
        <div style={{background:"rgba(245,158,11,.08)",border:"1px solid rgba(245,158,11,.2)",borderRadius:9,padding:"9px 13px",marginBottom:13,fontSize:11.5,color:"#fcd34d"}}>
          ⚠️ ITC for **IT Solutions** assumes bank debits are **GST-inclusive @ 18%** (CGST+SGST). Match to vendor tax invoices & GSTR-2B before claiming. Verify with your CA on gstin.gov.in
        </div>
        <div style={S.tabs}>
          {[["mon","Monthly"],["g1","GSTR-1"],["g3b","GSTR-3B"],["itc","ITC"]].map(([k,l])=><button key={k} onClick={()=>setGTab(k)} style={S.tab(gTab===k)}>{l}</button>)}
        </div>
        {gTab==="mon"&&<Tbl cols={[{h:"Month",cell:r=><span style={{fontFamily:"monospace",fontWeight:700}}>{r.month}</span>},{h:"Receipt (₹)",r:true,cell:r=><span style={{color:"#10b981",fontFamily:"monospace"}}>₹{inr0(r.rev)}</span>},{h:"Taxable (Est.)",r:true,cell:r=>"₹"+inr0(r.taxable)},{h:"Output GST",r:true,cell:r=><span style={{color:"#6B7AFF",fontFamily:"monospace"}}>₹{inr0(r.gst)}</span>},{h:"Net Payable",r:true,cell:r=><span style={{color:"#f43f5e",fontFamily:"monospace",fontWeight:700}}>₹{inr0(r.net)}</span>},{h:"Status",cell:r=><Chip cat={r.filed?"Revenue":"Bank Charges"} label={r.filed?"Filed":"Pending"}/>}]} rows={rows}/>}
        {gTab==="g1"&&<div style={S.card}><div style={{fontSize:12,fontWeight:700,marginBottom:12}}>GSTR-1 — Outward Supply Filing Guide</div><div style={S.g4}><Stat label="SAC Code" value="998314" sub="IT Services"/><Stat label="GST Rate" value="18%" sub="CGST+SGST"/><Stat label="Deadline" value="11th" sub="of each month"/><Stat label="Frequency" value="Monthly" sub="or QRMP &lt;₹5Cr"/></div><div style={{background:"rgba(107,122,255,.08)",border:"1px solid rgba(107,122,255,.2)",borderRadius:9,padding:"9px 13px",fontSize:11.5,color:"#0369a1"}}>Classify **B2B** NEFT/IMPS credits using the revenue categories in your ledger (e.g. B2B services @ 18%). Collect counterparty **GSTINs** and tax invoices before filing.</div><div style={{background:"rgba(107,122,255,.08)",border:"1px solid rgba(107,122,255,.2)",borderRadius:9,padding:"9px 13px",marginTop:12,fontSize:11.5,color:"#0369a1"}}><strong>Inward (purchases):</strong> Record vendor invoices (e.g. SAC **998313 / 998314** for IT services) as expenses; reconcile **ITC** in **GSTR-2B** with bank payments to those vendors.</div></div>}
        {gTab==="g3b"&&<div style={S.card}><div style={{fontSize:12,fontWeight:700,marginBottom:12}}>GSTR-3B Summary (Estimated)</div><Tbl cols={[{h:"Head",k:"h"},{h:"Description",k:"d"},{h:"IGST",r:true,k:"i"},{h:"CGST",r:true,k:"c"},{h:"SGST",r:true,k:"s"}]} rows={[{h:"3.1(a)",d:"Outward taxable supplies",i:"₹0",c:"₹"+inr0(outCgst),s:"₹"+inr0(outSgst)},{h:"4. ITC",d:"Input Tax Credit (IT Solutions + bank, est.)",i:"₹0",c:"₹"+inr0(itcCgstTot),s:"₹"+inr0(itcSgstTot)},{h:"6. Net",d:"Net GST Payable (est.)",i:"₹0",c:"₹"+inr0(netCgst),s:"₹"+inr0(netSgst)}]}/></div>}
        {gTab==="itc"&&<>
          <div style={{background:"rgba(107,122,255,.06)",border:"1px solid rgba(107,122,255,.25)",borderRadius:9,padding:"10px 13px",marginBottom:12,fontSize:11.5,color:"#BFDBFE"}}>
            Debits whose narration matches <strong>IT SOLUTIONS</strong> are categorised as <strong>Vendor - IT Solutions</strong> (expense). Below splits use <strong>18% inclusive</strong> GST for ITC planning — replace with figures from actual invoices.
          </div>
          <Tbl cols={[{h:"Date",k:"date"},{h:"Vendor",k:"v"},{h:"Narration",k:"d"},{h:"Gross",r:true,k:"a"},{h:"Taxable (est.)",r:true,k:"tx"},{h:"GST",r:true,k:"g"},{h:"CGST",r:true,k:"cg"},{h:"SGST",r:true,k:"sg"},{h:"SAC",k:"sac"},{h:"Status",cell:r=><Chip cat={r.v==="IT Solutions"?"Vendor - IT Solutions":"Bank Charges"} label={r.v==="IT Solutions"?"Expense + ITC":"Fee ITC"}/>}]} rows={itcRows} empty="No Vendor - IT Solutions or Bank Charges debits in the ledger."/>
        </>}
      </div>
    )
  }

  const Pay = () => {
    const sal = reportLedger.filter(t=>t.drCr==="DR"&&(t.category==="Director Payment"||t.category==="Salary"))
    const salDr = reportLedger.filter(t=>t.drCr==="DR"&&t.category==="Salary")
    const salTotal = salDr.reduce((s,t)=>s+t.amount,0)
    const fltr = sal.filter(t=>!fCat||t.category===fCat)
    return (
      <div>
        <div style={S.g4}>
          <Stat label="Salary (employees)" value={"₹"+inr0(salTotal)} sub="Category: Salary" color="#f43f5e"/>
          <Stat label="Director payment (DR)" value={"₹"+inr0(sal.filter(t=>t.category==="Director Payment").reduce((s,t)=>s+t.amount,0))} color="#f43f5e"/>
          <Stat label="Salary payouts" value={String(salDr.length)} sub="Debit transactions" color="#94a3b8"/>
          <Stat label="Salary + Director (DR)" value={"₹"+inr0(sal.reduce((s,t)=>s+t.amount,0))} color="#f59e0b"/>
        </div>
        <div style={S.tabs}>
          {[["all","All Payments"],["tds","TDS"],["pf","PF/ESI"]].map(([k,l])=><button key={k} onClick={()=>setPTab(k)} style={S.tab(pTab===k)}>{l}</button>)}
        </div>
        {pTab==="all"&&<>
          <div style={{display:"flex",gap:7,marginBottom:13}}>
            <select value={fCat} onChange={e=>setFCat(e.target.value)} style={{...S.sel,width:190}}><option value="">All Categories</option><option>Director Payment</option><option>Salary</option></select>
            <button onClick={()=>setModal("emp")} style={{...S.btn,fontSize:11,padding:"5px 11px"}}>+ Add Employee</button>
          </div>
          <Tbl cols={[{h:"Date",k:"date"},{h:"Narration",cell:r=><span style={{fontSize:11,color:"#94a3b8"}}>{r.particulars.substring(0,48)}</span>},{h:"Category",cell:r=><Chip cat={r.category}/>},{h:"Amount",r:true,cell:r=><span style={{color:"#f43f5e",fontFamily:"monospace",fontWeight:700}}>₹{inr(r.amount)}</span>},{h:"FY",cell:r=><Chip cat="Bank Charges" label={r.fy}/>}]} rows={fltr}/>
        </>}
        {pTab==="tds"&&<div style={S.card}><div style={{background:"rgba(245,158,11,.08)",border:"1px solid rgba(245,158,11,.2)",borderRadius:9,padding:"9px 13px",marginBottom:12,fontSize:11.5,color:"#fcd34d"}}>TDS u/s 192 (illustrative): ledger shows Director Payment DR <strong>₹{inr0(sal.filter(t=>t.category==="Director Payment").reduce((s,t)=>s+t.amount,0))}</strong> · Salary DR <strong>₹{inr0(salTotal)}</strong>. Replace with payee-wise payroll registers for filing. Challan 281 by 7th.</div><Tbl cols={[{h:"Payee / bucket",k:"p"},{h:"Ledger total (DR)",k:"t"},{h:"Std Deduction",k:"s"},{h:"Taxable (illustr.)",k:"x"},{h:"Slab",k:"sl"},{h:"Est. TDS",r:true,k:"e"}]} rows={[{p:"Director Payment (sum)",t:"₹"+inr0(sal.filter(t=>t.category==="Director Payment").reduce((s,t)=>s+t.amount,0)),s:"—",x:"—",sl:"Per return",e:"—"},{p:"Salary (sum)",t:"₹"+inr0(salTotal),s:"—",x:"—",sl:"Per return",e:"—"},{p:"All other payroll DR",t:"₹0",s:"—",x:"—",sl:"—",e:"—"}]}/></div>}
        {pTab==="pf"&&<div style={S.card}><div style={{background:"rgba(107,122,255,.08)",border:"1px solid rgba(107,122,255,.2)",borderRadius:9,padding:"9px 13px",marginBottom:12,fontSize:11.5,color:"#0369a1"}}>PF applicable when ≥20 employees. ESI for salary ≤₹21,000/month. Register on epfindia.gov.in and esic.in.</div><Tbl cols={[{h:"Contribution",k:"c"},{h:"When Applicable",k:"w"},{h:"Employer",k:"er"},{h:"Employee",k:"ee"},{h:"Due",k:"d"}]} rows={[{c:"EPF",w:"≥20 employees",er:"13% Basic",ee:"12% Basic",d:"15th next month"},{c:"ESI",w:"Salary ≤₹21k",er:"3.25%",ee:"0.75%",d:"15th next month"},{c:"Prof Tax (UP)",w:"All salaried",er:"—",ee:"₹200/mo",d:"Monthly"}]}/></div>}
      </div>
    )
  }

  const Rep = () => {
    const plTotalCr = crByCat.reduce((s, [, v]) => s + v, 0)
    const plTotalDr = drByCat.reduce((s, [, v]) => s + v, 0)
    const plNet = Math.round((plTotalCr - plTotalDr) * 100) / 100
    const b = cfBuckets
    const netOpsDetail = Math.round((b.revSvc + b.otherCr - b.salRem - b.vendor - b.misc - b.bankCh - b.otherDr) * 100) / 100
    const bankBal = reportStats.balance
    const gstLiab = outputGstFromRev
    const retainedPlug = Math.round((bankBal - gstLiab - capitalCr) * 100) / 100
    const assetsOther = 0
    const assetsTot = Math.round((bankBal + assetsOther) * 100) / 100
    const leTot = Math.round((gstLiab + capitalCr + retainedPlug) * 100) / 100
    const tbRows = tbReport.rows.map(r => ({
      a: r.account,
      d: r.debit > 0.005 ? "₹" + inr0(r.debit) : "—",
      c: r.credit > 0.005 ? "₹" + inr0(r.credit) : "—",
    }))
    tbRows.push({ a: "TOTAL", d: "₹" + inr0(tbReport.tDr), c: "₹" + inr0(tbReport.tCr) })
    const monRows = monthlyFlow.length ? monthlyFlow : [{ m: "—", cr: 0, dr: 0 }]
    const cfRows = [
      ["OPERATING ACTIVITIES", true],
      ["Revenue-* receipts (detail)", "+" + "₹" + inr0(b.revSvc), false, "#10b981"],
      ["Other receipts (excl. capital)", "+" + "₹" + inr0(b.otherCr), false, "#10b981"],
      ["Salary & director (DR)", "-" + "₹" + inr0(b.salRem), false, "#f43f5e"],
      ["Vendor & recruitment (DR)", "-" + "₹" + inr0(b.vendor), false, "#f43f5e"],
      ["Misc expense (DR)", "-" + "₹" + inr0(b.misc), false, "#f43f5e"],
      ["Bank charges (DR)", "-" + "₹" + inr0(b.bankCh), false, "#f43f5e"],
      ["Other payments (DR)", "-" + "₹" + inr0(b.otherDr), false, "#f43f5e"],
      [
        "Net from operations (detail)",
        (netOpsDetail >= 0 ? "+" : "-") + "₹" + inr0(Math.abs(netOpsDetail)),
        false,
        netOpsDetail >= 0 ? "#10b981" : "#f43f5e",
        true,
      ],
      ["FINANCING ACTIVITIES", true],
      ["Capital infusions (CR)", "+" + "₹" + inr0(b.cap), false, "#10b981"],
      ["Net from financing", "+" + "₹" + inr0(b.cap), false, "#10b981", true],
      [
        "NET CHANGE IN CASH (CR − DR)",
        (reportStats.flowNet >= 0 ? "+" : "-") + "₹" + inr0(Math.abs(reportStats.flowNet)) + " → Closing ₹" + inr0(bankBal),
        false,
        reportStats.flowNet >= 0 ? "#10b981" : "#f43f5e",
        true,
      ],
    ]
    return (
      <div>
        <div style={S.tabs}>
          {[
            ["pl", "P&L"],
            ["bs", "Balance Sheet"],
            ["cf", "Cash Flow"],
            ["mon", "Monthly"],
            ["tb", "Trial Balance"],
          ].map(([k, l]) => (
            <button key={k} onClick={() => setRTab(k)} style={S.tab(rTab === k)}>
              {l}
            </button>
          ))}
        </div>
        {rTab === "pl" && (
          <div>
            <div style={S.g2}>
              <div style={{ ...S.card, maxHeight: 360, overflowY: "auto" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#10b981", marginBottom: 12 }}>📈 Credits (by category)</div>
                {crByCat.length === 0 ? (
                  <div style={{ color: "#64748b", fontSize: 11 }}>No credit entries.</div>
                ) : (
                  crByCat.map(([n, v]) => (
                    <div key={n} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid #e0f2fe", fontSize: 11.5 }}>
                      <span style={{ color: "#94a3b8" }}>{n}</span>
                      <span style={{ color: "#10b981", fontFamily: "monospace", fontWeight: 700 }}>₹{inr0(v)}</span>
                    </div>
                  ))
                )}
                <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", fontSize: 13, fontWeight: 800 }}>
                  <span>Total credits</span>
                  <span style={{ color: "#10b981", fontFamily: "monospace" }}>₹{inr0(plTotalCr)}</span>
                </div>
              </div>
              <div style={{ ...S.card, maxHeight: 360, overflowY: "auto" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#f43f5e", marginBottom: 12 }}>📉 Debits (by category)</div>
                {drByCat.length === 0 ? (
                  <div style={{ color: "#64748b", fontSize: 11 }}>No debit entries.</div>
                ) : (
                  drByCat.map(([n, v]) => (
                    <div key={n} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid #e0f2fe", fontSize: 11.5 }}>
                      <span style={{ color: "#94a3b8" }}>{n}</span>
                      <span style={{ color: "#f43f5e", fontFamily: "monospace", fontWeight: 700 }}>₹{inr0(v)}</span>
                    </div>
                  ))
                )}
                <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", fontSize: 13, fontWeight: 800 }}>
                  <span>Total debits</span>
                  <span style={{ color: "#f43f5e", fontFamily: "monospace" }}>₹{inr0(plTotalDr)}</span>
                </div>
              </div>
            </div>
            <div style={{ ...S.card, textAlign: "center" }}>
              <div style={{ fontSize: 11, color: "#64748b", marginBottom: 7 }}>Net (cash basis): total credits − total debits</div>
              <div style={{ fontSize: 32, fontWeight: 800, color: plNet >= 0 ? "#10b981" : "#f43f5e", fontFamily: "monospace" }}>
                {plNet >= 0 ? "+" : "-"} ₹{inr0(Math.abs(plNet))}
              </div>
              <div style={{ fontSize: 11, color: "#64748b", marginTop: 5 }}>Capital credited (financing): ₹{inr0(capitalCr)}</div>
              <div style={{ fontSize: 17, fontWeight: 800, color: "#6B7AFF", marginTop: 7, fontFamily: "monospace" }}>Closing bank (statement column): ₹{inr0(bankBal)}</div>
            </div>
          </div>
        )}
        {rTab === "mon" && (
          <Tbl
            cols={[
              { h: "Month", cell: r => <span style={{ fontFamily: "monospace", fontWeight: 700 }}>{r.m}</span> },
              { h: "Receipts", r: true, cell: r => <span style={{ color: "#10b981", fontFamily: "monospace" }}>₹{inr(r.cr)}</span> },
              { h: "Payments", r: true, cell: r => <span style={{ color: "#f43f5e", fontFamily: "monospace" }}>₹{inr(r.dr)}</span> },
              {
                h: "Net",
                r: true,
                cell: r => (
                  <span style={{ color: r.cr >= r.dr ? "#10b981" : "#f43f5e", fontFamily: "monospace", fontWeight: 700 }}>
                    {r.cr >= r.dr ? "+" : "-"}₹{inr(Math.abs(r.cr - r.dr))}
                  </span>
                ),
              },
              { h: "Status", cell: r => <Chip cat={r.cr >= r.dr ? "Revenue" : "Director Payment"} label={r.cr >= r.dr ? "SURPLUS" : "DEFICIT"} /> },
            ]}
            rows={monRows}
            empty="No monthly data yet."
          />
        )}
        {rTab === "bs" && (
          <div style={S.g2}>
            <div style={S.card}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 11 }}>Assets (simplified)</div>
              {[
                ["Cash & Bank (closing)", "₹" + inr0(bankBal)],
                ["Fixed assets / other (manual)", "₹" + inr0(assetsOther)],
              ].map(([n, v]) => (
                <div key={n} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid #e0f2fe", fontSize: 11.5 }}>
                  <span style={{ color: "#94a3b8" }}>{n}</span>
                  <span style={{ fontFamily: "monospace", fontWeight: 700 }}>{v}</span>
                </div>
              ))}
              <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", fontSize: 13, fontWeight: 800 }}>
                <span>Total</span>
                <span style={{ color: "#6B7AFF", fontFamily: "monospace" }}>₹{inr0(assetsTot)}</span>
              </div>
            </div>
            <div style={S.card}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 11 }}>Liabilities & capital (indicative)</div>
              {[
                ["GST output (est. @18% on Revenue-*)", "₹" + inr0(gstLiab)],
                ["TDS payable (est.)", "—"],
                ["Capital infused (CR)", "₹" + inr0(capitalCr)],
                ["Retained / balancing (plug)", (retainedPlug < 0 ? "-₹" : "₹") + inr0(Math.abs(retainedPlug))],
              ].map(([n, v]) => (
                <div key={n} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid #e0f2fe", fontSize: 11.5 }}>
                  <span style={{ color: "#94a3b8" }}>{n}</span>
                  <span style={{ fontFamily: "monospace", fontWeight: 700, color: String(v).startsWith("-") ? "#f43f5e" : "#0c4a6e" }}>{v}</span>
                </div>
              ))}
              <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", fontSize: 13, fontWeight: 800 }}>
                <span>Total</span>
                <span style={{ color: "#6B7AFF", fontFamily: "monospace" }}>₹{inr0(leTot)}</span>
              </div>
              <div style={{ fontSize: 10, color: "#64748b", marginTop: 8, lineHeight: 1.5 }}>Plug line ties bank closing to GST (est.) + capital; add fixed assets &amp; TDS in books for a full BS.</div>
            </div>
          </div>
        )}
        {rTab === "cf" && (
          <div style={S.card}>
            {cfRows.map(([l, v, h, c, b], i) =>
              h ? (
                <div key={i} style={{ padding: "7px 0 3px", fontSize: 10, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: ".5px" }}>
                  {l}
                </div>
              ) : (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0 3px 14px", borderBottom: "1px solid #e0f2fe", fontSize: 11.5, fontWeight: b ? 700 : 400 }}>
                  <span style={{ color: "#94a3b8" }}>{l}</span>
                  <span style={{ fontFamily: "monospace", fontWeight: 700, color: c || "#0c4a6e" }}>{v}</span>
                </div>
              )
            )}
          </div>
        )}
        {rTab === "tb" && (
          <Tbl cols={[{ h: "Account", k: "a" }, { h: "Debit (₹)", r: true, k: "d" }, { h: "Credit (₹)", r: true, k: "c" }]} rows={tbRows} empty="No journal data — add transactions." />
        )}
      </div>
    )
  }

  const renderPage = () => {
    switch(page){
      case "dash": return <Dash/>
      case "txn": return <Txn/>
      case "inv": return <Inv/>
      case "led": return <Led/>
      case "coa": return <Coa/>
      case "gst": return <GST/>
      case "pay": return <Pay/>
      case "rep": return <Rep/>
      case "ai":
        return (
          <Chat
            key={activeCompanyId}
            onAddBatch={addTxnBatchFromChat}
            acctRole={acctRole}
            snap={chatSnap}
            systemPrompt={chatSystemPrompt}
            welcomeName={activeCompany?.name || "your company"}
          />
        )
      case "stock": {
        const invVal = inventory.reduce((s, r) => s + (Number(r.qty) || 0) * (Number(r.unitVal) || 0), 0)
        const lic = inventory.filter(r => /license|zoho|jira|aws/i.test(String(r.item || ""))).length
        const low = inventory.filter(r => r.status === "low").length
        const rows = inventory.map(r => ({
          item: r.item,
          hsn: r.hsn,
          qty: r.qty,
          val: "₹" + inr0(r.unitVal || 0),
          tot: "₹" + inr0((Number(r.qty) || 0) * (Number(r.unitVal) || 0)),
          s: r.status || "ok",
        }))
        return (
          <div>
            <div style={S.g4}>
              <Stat label="Total Items" value={String(inventory.length)} />
              <Stat label="Asset Value" value={"₹" + inr0(invVal)} />
              <Stat label="Licenses (est.)" value={String(lic)} color="#10b981" />
              <Stat label="Low stock" value={String(low)} color={low ? "#f59e0b" : "#94a3b8"} />
            </div>
            <div style={{ display: "flex", gap: 7, marginBottom: 13 }}>
              <button type="button" onClick={() => setModal("item")} style={{ ...S.btn, fontSize: 11, padding: "5px 11px" }}>
                + Add Item
              </button>
            </div>
            <Tbl
              cols={[
                { h: "Item", k: "item" },
                { h: "HSN/SAC", k: "hsn" },
                { h: "Qty", k: "qty" },
                { h: "Unit Value", r: true, k: "val" },
                { h: "Total", r: true, k: "tot" },
                {
                  h: "Status",
                  cell: r => <Chip cat={r.s === "ok" ? "Revenue" : "Bank Charges"} label={r.s === "low" ? "Low Stock" : "In Stock"} />,
                },
              ]}
              rows={rows}
              empty="No inventory — add items after you upload purchase data."
            />
          </div>
        )
      }
      case "rec": {
        const creds = ledger.filter(t => !t.void && t.drCr === "CR")
        const n = creds.length
        return (
          <div>
            <div style={S.g4}>
              <Stat label="Credit lines" value={String(n)} />
              <Stat label="With category" value={String(n)} color="#10b981" />
              <Stat label="Review queue" value="0" color="#94a3b8" />
              <Stat label="Match rate" value={n ? "100%" : "—"} color="#10b981" />
            </div>
            <div style={{ marginBottom: 13 }}>
              <button type="button" onClick={() => toast_("Match rules applied to your credit lines in the ledger.")} style={{ ...S.btn, background: "#10b981", fontSize: 11 }}>
                ⚡ Auto-Match All
              </button>
            </div>
            <Tbl
              cols={[
                { h: "Date", k: "date" },
                { h: "Narration", cell: r => <span style={{ fontSize: 11, color: "#94a3b8" }}>{r.particulars.substring(0, 44)}</span> },
                { h: "Amount", r: true, cell: r => <span style={{ color: "#10b981", fontFamily: "monospace" }}>₹{inr(r.amount)}</span> },
                { h: "Category", cell: r => <Chip cat={r.category} /> },
                { h: "Status", cell: () => <Chip cat="Revenue" label="✓ Matched" /> },
              ]}
              rows={creds.slice(-10).reverse()}
              empty="No credit transactions yet."
            />
          </div>
        )
      }
      case "bulk": return (
        <div>
          <div style={S.g2}>
            <div style={S.card}>
              <div style={{fontSize:12,fontWeight:700,marginBottom:12}}>📤 Upload Bank Statement</div>
              <div onClick={()=>document.getElementById("fi").click()} style={{border:"2px dashed #bae6fd",borderRadius:10,padding:32,textAlign:"center",cursor:"pointer"}} onMouseEnter={e=>{e.currentTarget.style.borderColor="#6B7AFF";e.currentTarget.style.background="rgba(107,122,255,.04)"}} onMouseLeave={e=>{e.currentTarget.style.borderColor="#bae6fd";e.currentTarget.style.background="transparent"}}>
                <div style={{fontSize:32,marginBottom:9}}>📄</div>
                <div style={{fontWeight:700,color:"#94a3b8",marginBottom:5,fontSize:12}}>Drop bank statement here</div>
                <div style={{fontSize:11,color:"#64748b"}}>CSV · XLSX · Axis Bank · HDFC · ICICI · SBI · Kotak</div>
                <input id="fi" type="file" accept=".csv,.xlsx,.xls,.txt" style={{display:"none"}} onChange={handleBankStatementFile}/>
              </div>
            </div>
            <div style={S.card}>
              <div style={{fontSize:12,fontWeight:700,marginBottom:12}}>⚡ How It Works</div>
              {["Upload CSV/XLSX from your bank portal","AI auto-categorises each NEFT/IMPS/UPI entry","Review & correct any mismatches","Import — all entries added to ledger"].map((s,i)=>(
                <div key={i} style={{display:"flex",gap:9,alignItems:"flex-start",marginBottom:10}}>
                  <div style={{width:20,height:20,background:"#6B7AFF",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:800,color:"#fff",flexShrink:0}}>{i+1}</div>
                  <div style={{fontSize:11.5,color:"#94a3b8",lineHeight:1.6}}>{s}</div>
                </div>
              ))}
            </div>
          </div>
          <div style={S.card}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <div style={{fontSize:12,fontWeight:700}}>📋 Import History</div>
              <div style={{display:"flex",gap:7}}>
                {importHistory.length>0&&<button type="button" onClick={()=>{if(confirm("Clear import history list?"))setImportHistory([])}} style={{...S.btnO,fontSize:11,color:"#f43f5e",borderColor:"rgba(244,63,94,.35)"}}>Clear list</button>}
                <button type="button" onClick={()=>{const h="Date,Narration,Remarks,Withdrawal,Deposit,Balance\n24/01/2025,NEFT IN-123/ACME Pvt Ltd,Invoice 1042 · GST period Mar,0,24360,150000\n24/01/2025,UPI-SALARY,,25000,0,125000\n";const b=new Blob([h],{type:"text/csv"});const a=document.createElement("a");a.href=URL.createObjectURL(b);a.download="jm_tally_template.csv";a.click()}} style={{...S.btnO,fontSize:11}}>⬇ Template</button>
              </div>
            </div>
            <Tbl cols={[{h:"Date",k:"d"},{h:"File",k:"f"},{h:"Period",k:"p"},{h:"Txns",k:"t"},{h:"Status",cell:r=><Chip cat={r.status==="Done"?"Revenue":r.status==="Failed"?"Director Payment":r.status==="Nothing new"?"Bank Charges":"Bank Charges"} label={String(r.status)}/>}]} rows={importHistory} empty="No imports yet — upload a CSV or Excel statement to import."/>
          </div>
        </div>
      )
      default: return <div style={{color:"#64748b",padding:40,textAlign:"center"}}>Coming soon</div>
    }
  }

  return (
    <div style={S.wrap}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');*{box-sizing:border-box;margin:0;padding:0}::-webkit-scrollbar{width:4px;height:4px}::-webkit-scrollbar-thumb{background:rgba(107,122,255,.45);border-radius:10px}select option{background:#ffffff;color:#0c4a6e}@keyframes spin{to{transform:rotate(360deg)}}`}</style>

      {toast&&<div style={{position:"fixed",top:14,right:14,background:toast.c,color:"#fff",padding:"9px 16px",borderRadius:9,fontSize:12,fontWeight:700,zIndex:9999,boxShadow:"0 4px 20px rgba(0,0,0,.4)"}}>{toast.msg}</div>}

      {/* SIDEBAR */}
      <div style={S.sb}>
        <div style={{ padding: "14px 16px", borderBottom: `1px solid ${SKY.borderHi}` }}>
          <div style={{display:"flex",alignItems:"center",gap:9}}>
            <img src="/logo.png" alt="" width={36} height={36} style={{ objectFit: "contain", flexShrink: 0 }} />
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 800, color: JM.p }}>JM Tally</div>
              <div style={{ fontSize: 9, color: JM.p, textTransform: "uppercase", letterSpacing: ".5px", marginTop: 1, fontWeight: 700 }} title={activeCompany?.legalName || ""}>
                {activeCompany?.name || "Company"}
              </div>
            </div>
          </div>
        </div>
        <div style={{ margin: "10px 12px 6px", background: JM.cardTint, border: `1px solid ${JM.r(0.22)}`, borderRadius: 9, padding: "10px 12px" }}>
          <div style={{fontSize:9,color:"#475569",fontWeight:600,letterSpacing:".5px",textTransform:"uppercase"}}>Bank balance</div>
          <div style={{fontSize:17,fontWeight:800,color:"#0c4a6e",marginTop:2,fontFamily:"monospace",letterSpacing:-1}}>₹{inr0(stats.balance)}</div>
          <div style={{ fontSize: 9, color: "#475569", marginTop: 2, lineHeight: 1.35 }} title="Set under Companies">
            {activeCompany?.bankAccountLabel || "Bank label · set in Companies"}
          </div>
        </div>
        <nav style={{flex:1,overflowY:"auto",padding:"3px 9px"}}>
          {nav.map(g=>(
            <div key={g.g}>
              <div style={{fontSize:9,color:"#475569",padding:"9px 7px 3px",letterSpacing:"1px",textTransform:"uppercase",fontWeight:700}}>{g.g}</div>
              {g.n.map(([ic,k])=>(
                <button key={k} onClick={()=>{setPage(k);setFCat("");setSearch("")}} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderRadius:8,cursor:"pointer",width:"100%",textAlign:"left",fontSize:12,fontWeight:500,border:"none",background:page===k?JM.r(0.16):"transparent",color:page===k?JM.soft:"#94a3b8",position:"relative"}}>
                  <span style={{opacity:page===k?1:.6,fontSize:12,width:14,textAlign:"center"}}>{ic}</span>
                  <span>{pages[k]}</span>
                  {k==="gst"&&<span style={{marginLeft:"auto",background:"#f43f5e",color:"#fff",borderRadius:20,fontSize:8,fontWeight:700,padding:"1px 5px"}}>!</span>}
                  {page===k&&<div style={{position:"absolute",left:0,top:"25%",bottom:"25%",width:3,background:JM.p,borderRadius:"0 3px 3px 0"}}/>}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div style={{ padding: "10px 12px", borderTop: `1px solid ${SKY.borderHi}`, display: "flex", alignItems: "center", gap: 8 }}>
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: JM.r(0.12),
              border: `1px solid ${JM.r(0.25)}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
              flexShrink: 0,
            }}
          >
            <img src="/logo.png" alt="" width={22} height={22} style={{ objectFit: "contain" }} />
          </div>
          <div>
            <div style={{fontSize:11,fontWeight:700,color:"#0c4a6e"}}>{acctRole} <span style={{fontSize:8,background:JM.r(0.2),color:JM.soft,padding:"1px 6px",borderRadius:20,fontWeight:700}}>{acctRole}</span></div>
            <div style={{fontSize:9,color:"#475569"}}>{repFy ? formatFyLabel(repFy) : "All FYs"}</div>
          </div>
        </div>
      </div>

      {/* MAIN */}
      <div style={S.main}>
        <div style={S.bar}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 0, flex: "1 1 240px" }}>
              <img src="/logo.png" alt="" width={40} height={40} style={{ objectFit: "contain", flexShrink: 0 }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 10, fontWeight: 800, color: JM.p, letterSpacing: "0.06em", textTransform: "uppercase" }}>JM Tally</div>
                <div style={{ fontSize: 19, fontWeight: 800, color: "#0c4a6e", letterSpacing: "-0.03em", lineHeight: 1.2, marginTop: 2 }}>{pages[page]}</div>
                <div style={{ fontSize: 11, color: "#64748b", marginTop: 6, lineHeight: 1.4 }}>
                  <span style={{ color: JM.p, fontWeight: 700 }}>{activeCompany?.legalName || activeCompany?.name || "Company"}</span>
                  {activeCompany?.bankAccountLabel ? (
                    <span style={{ color: "#64748b", fontWeight: 500 }}> · {activeCompany.bankAccountLabel}</span>
                  ) : (
                    <span style={{ fontStyle: "italic", opacity: 0.85 }}> · Set bank in Companies</span>
                  )}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", flexShrink: 0 }}>
              <span
                style={{
                  background: "rgba(244,63,94,.12)",
                  color: "#fb7185",
                  border: "1px solid rgba(244,63,94,.35)",
                  padding: "6px 12px",
                  borderRadius: 999,
                  fontSize: 11,
                  fontWeight: 700,
                  whiteSpace: "nowrap",
                }}
              >
                GST due 20 Mar
              </span>
              <button
                type="button"
                onClick={() => setModal("txn")}
                disabled={acctRole === "Viewer"}
                style={{
                  ...S.btn,
                  padding: "9px 18px",
                  fontSize: 13,
                  borderRadius: 10,
                  boxShadow: acctRole === "Viewer" ? "none" : `0 4px 14px ${JM.r(0.35)}`,
                  opacity: acctRole === "Viewer" ? 0.45 : 1,
                  cursor: acctRole === "Viewer" ? "default" : "pointer",
                }}
              >
                {acctRole === "Viewer" ? "View-only" : "+ Add transaction"}
              </button>
            </div>
          </div>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 10,
              paddingTop: 4,
              borderTop: `1px solid ${SKY.border}`,
            }}
          >
            <div style={hdrGroup}>
              <span style={hdrLbl}>Workspace</span>
              <select
                value={activeCompanyId}
                onChange={e => void switchCompany(e.target.value)}
                title="Active company"
                style={{ ...hdrInput, minWidth: 140, maxWidth: 220, cursor: "pointer" }}
              >
                {companies.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => setModal("companies")} style={{ ...S.btnO, fontSize: 11, padding: "6px 12px", borderColor: "#475569", color: "#0369a1" }}>
                Companies
              </button>
            </div>
            <div style={hdrGroup}>
              <span style={hdrLbl}>Role</span>
              <select value={acctRole} onChange={e => setAcctRole(e.target.value)} title="Role-based access" style={{ ...hdrInput, width: 124, cursor: "pointer" }}>
                <option>Admin</option>
                <option>Accountant</option>
                <option>Viewer</option>
              </select>
              <span style={{ width: 1, height: 20, background: "#bae6fd", margin: "0 2px" }} aria-hidden />
              <span style={hdrLbl}>Lock books to</span>
              <input type="date" value={periodLockIso} onChange={e => setPeriodLockIso(e.target.value)} title="Block posting on or before this date" style={{ ...hdrInput, width: 138 }} />
              {periodLockIso ? (
                <button type="button" onClick={() => setPeriodLockIso("")} style={{ ...S.btnO, fontSize: 11, padding: "5px 10px", borderColor: "#475569" }}>
                  Clear lock
                </button>
              ) : null}
            </div>
            <div style={hdrGroup}>
              <span style={hdrLbl} title="Indian financial year (April–March)">
                Financial year
              </span>
              <select
                value={repFy}
                onChange={e => {
                  setRepFy(e.target.value)
                  setRepMonthKey("")
                }}
                style={{ ...hdrInput, width: 128, cursor: "pointer" }}
              >
                <option value="">All FYs</option>
                {distinctFYs(ledger).map(fy => (
                  <option key={fy} value={fy}>
                    {formatFyLabel(fy)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
        <div style={S.cnt}>
          {["dash", "gst", "pay", "inv", "rep"].includes(page) && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 10,
                alignItems: "center",
                marginBottom: 16,
                padding: "12px 14px",
                background: "#ffffff",
                border: "1px solid #bae6fd",
                borderRadius: 12,
              }}
            >
              <span style={{ fontSize: 10, color: "#64748b", fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase" }}>Report drill-down</span>
              <span style={{ fontSize: 11, color: "#64748b" }}>
                FY: <strong style={{ color: "#94a3b8" }}>{repFy ? formatFyLabel(repFy) : "All (header)"}</strong>
              </span>
              <select value={repMonthKey} onChange={e => setRepMonthKey(e.target.value)} disabled={!repFy} style={{ ...hdrInput, width: 144, cursor: "pointer", opacity: repFy ? 1 : 0.5 }}>
                <option value="">All months</option>
                {(repFy ? fyToMonthOptions(repFy) : []).map(m => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
              <label style={{ fontSize: 11, color: "#94a3b8", display: "flex", alignItems: "center", gap: 6 }}>
                From
                <input type="date" value={repFromIso} onChange={e => setRepFromIso(e.target.value)} style={{ ...hdrInput, width: 136 }} />
              </label>
              <label style={{ fontSize: 11, color: "#94a3b8", display: "flex", alignItems: "center", gap: 6 }}>
                To
                <input type="date" value={repToIso} onChange={e => setRepToIso(e.target.value)} style={{ ...hdrInput, width: 136 }} />
              </label>
              <button
                type="button"
                onClick={() => {
                  setRepFy("")
                  setRepMonthKey("")
                  setRepFromIso("")
                  setRepToIso("")
                }}
                style={{ ...S.btnO, fontSize: 11, padding: "6px 12px", borderColor: "#475569" }}
              >
                Reset period filters
              </button>
            </div>
          )}
          {renderPage()}
        </div>
      </div>

      {/* MODALS */}
      <Modal
        open={modal === "companies"}
        title="Companies & workspaces"
        onClose={() => setModal(null)}
        onSave={async () => {
          if (!activeCompanyId || acctRole === "Viewer") return
          await saveCompanyProfile(activeCompanyId, {
            name: coDraft.name.trim() || "Company",
            legalName: coDraft.legalName.trim(),
            bankAccountLabel: coDraft.bankAccountLabel.trim(),
          })
          setModal(null)
        }}
        saveDisabled={acctRole === "Viewer"}
        saveLabel={acctRole === "Viewer" ? "View-only" : "Save company"}
      >
        <div style={{ fontSize: 11, color: "#94a3b8", lineHeight: 1.55, marginBottom: 14 }}>
          Each company keeps its own ledger, invoices, bank imports, and audit trail. Switch from the top bar or here — data stays in this browser until you host or sync elsewhere.
        </div>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", marginBottom: 8 }}>ALL WORKSPACES</div>
          {companies.map(c => (
            <div
              key={c.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 10px",
                background: SKY.surface,
                borderRadius: 8,
                marginBottom: 6,
                border: `1px solid ${SKY.borderHi}`,
              }}
            >
              <span style={{ flex: 1, fontSize: 12, color: "#0c4a6e" }}>
                {c.name}
                {c.id === activeCompanyId ? <span style={{ color: "#0369a1", fontSize: 10 }}> · active</span> : null}
              </span>
              {c.id !== activeCompanyId && (
                <button
                  type="button"
                  disabled={acctRole === "Viewer"}
                  onClick={() => void switchCompany(c.id)}
                  style={{ ...S.btnO, fontSize: 10, padding: "4px 10px" }}
                >
                  Open
                </button>
              )}
              <button
                type="button"
                disabled={acctRole === "Viewer" || companies.length <= 1}
                onClick={() => void deleteCompany(c.id)}
                style={{ ...S.btnO, fontSize: 10, padding: "4px 10px", color: "#f43f5e", borderColor: "rgba(244,63,94,.35)" }}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          disabled={acctRole === "Viewer"}
          onClick={() => void addCompany()}
          style={{ ...S.btn, marginBottom: 16, width: "100%" }}
        >
          + Add company
        </button>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", marginBottom: 8 }}>ACTIVE COMPANY</div>
        <F label="Display name">
          <input
            value={coDraft.name}
            onChange={e => setCoDraft(p => ({ ...p, name: e.target.value }))}
            style={IS}
            disabled={acctRole === "Viewer"}
          />
        </F>
        <F label="Legal name (optional)">
          <input
            value={coDraft.legalName}
            onChange={e => setCoDraft(p => ({ ...p, legalName: e.target.value }))}
            style={IS}
            disabled={acctRole === "Viewer"}
            placeholder="As on GST / MCA"
          />
        </F>
        <F label="Bank (label for header & AI)">
          <input
            value={coDraft.bankAccountLabel}
            onChange={e => setCoDraft(p => ({ ...p, bankAccountLabel: e.target.value }))}
            style={IS}
            disabled={acctRole === "Viewer"}
            placeholder="e.g. Axis Current · CA …099"
          />
        </F>
      </Modal>

      <Modal open={modal==="txn"} title="Add Transaction" onClose={()=>setModal(null)} onSave={()=>addTxn()} saveDisabled={acctRole==="Viewer"} saveLabel={acctRole==="Viewer"?"View-only":"Save Entry"}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:11}}>
          <F label="Date"><input type="date" value={nt.date} onChange={e=>setNt(p=>({...p,date:e.target.value}))} style={IS}/></F>
          <F label="Type"><select value={nt.drCr} onChange={e=>setNt(p=>({...p,drCr:e.target.value}))} style={IS}><option>Debit</option><option>Credit</option></select></F>
          <div style={{gridColumn:"1/-1"}}><F label="Description / Narration"><input value={nt.particulars} onChange={e=>setNt(p=>({...p,particulars:e.target.value}))} placeholder="e.g. NEFT from client — invoice ref" style={IS}/></F></div>
          <F label="Amount (₹)"><input type="number" value={nt.amount} onChange={e=>setNt(p=>({...p,amount:e.target.value}))} placeholder="0" style={IS}/></F>
          <F label="Category"><select value={nt.category} onChange={e=>setNt(p=>({...p,category:e.target.value}))} style={IS}>{CATS.map(c=><option key={c}>{c}</option>)}</select></F>
          <F label="Reference No."><input value={nt.ref} onChange={e=>setNt(p=>({...p,ref:e.target.value}))} placeholder="NEFT/IMPS/UPI ref · vendor invoice #" style={IS}/></F>
          {nt.category==="Vendor - IT Solutions"&&<div style={{gridColumn:"1/-1",fontSize:11,color:"#0369a1",lineHeight:1.5,padding:"8px 10px",background:"rgba(107,122,255,.1)",borderRadius:8,border:"1px solid rgba(107,122,255,.25)"}}>Payments to <strong>IT Solutions</strong> are <strong>expenses</strong> (P&amp;L / vendor ledger). For GST, use <strong>GST → ITC</strong>: splits use 18% inclusive CGST+SGST — reconcile with their invoice &amp; GSTR-2B.</div>}
        </div>
      </Modal>

      <Modal
        open={dangerFlow != null}
        title={dangerFlow?.kind === "void" ? "Void transaction?" : "Delete invoice?"}
        onClose={closeDangerModal}
        onSave={confirmDangerAction}
        saveDisabled={
          acctRole === "Viewer" || dangerRemark.trim().length < 3 || !dangerAck || dangerFlow == null
        }
        saveLabel={
          dangerFlow?.kind === "void"
            ? acctRole === "Viewer"
              ? "View-only"
              : "Void entry"
            : acctRole === "Viewer"
              ? "View-only"
              : "Delete invoice"
        }
      >
        {dangerFlow?.kind === "void" ? (
          <div style={{ fontSize: 12, color: SKY.text2, lineHeight: 1.6, marginBottom: 14 }}>
            The line stays in the books as <strong>voided</strong> (audit trail). It is excluded from balances and reports unless you show voided entries.
          </div>
        ) : (
          <div style={{ fontSize: 12, color: "#f43f5e", lineHeight: 1.6, marginBottom: 14 }}>
            This <strong>removes</strong> the invoice from the register. Ledger transactions already posted from payments are <strong>not</strong> removed automatically.
          </div>
        )}
        {dangerFlow?.kind === "void" &&
          (() => {
            const t = txns?.find(x => x.id === dangerFlow.id)
            if (!t) return null
            return (
              <div
                style={{
                  fontSize: 11,
                  color: SKY.muted,
                  marginBottom: 12,
                  padding: "10px 12px",
                  background: "#ffffff",
                  borderRadius: 8,
                  border: `1px solid ${SKY.borderHi}`,
                  fontFamily: "ui-monospace, monospace",
                }}
              >
                {t.date} · {t.drCr} · ₹{inr(t.amount)} · {String(t.particulars).slice(0, 120)}
                {String(t.particulars).length > 120 ? "…" : ""}
              </div>
            )
          })()}
        {dangerFlow?.kind === "invoice" &&
          (() => {
            const inv = invoices.find(i => i.id === dangerFlow.id)
            if (!inv) return null
            return (
              <div
                style={{
                  fontSize: 11,
                  color: SKY.muted,
                  marginBottom: 12,
                  padding: "10px 12px",
                  background: "#ffffff",
                  borderRadius: 8,
                  border: `1px solid ${SKY.borderHi}`,
                }}
              >
                <strong style={{ color: SKY.text }}>{inv.num}</strong> · {inv.client} · ₹{inr(inv.total)}
              </div>
            )
          })()}
        <F label="Remark (required)">
          <textarea
            value={dangerRemark}
            onChange={e => setDangerRemark(e.target.value)}
            rows={3}
            placeholder="Why are you voiding / deleting this? (min 3 characters)"
            style={{ ...IS, resize: "vertical", minHeight: 72 }}
          />
        </F>
        <label style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 12, color: SKY.text, cursor: "pointer", marginTop: 4 }}>
          <input type="checkbox" checked={dangerAck} onChange={e => setDangerAck(e.target.checked)} style={{ marginTop: 2 }} />
          <span>
            I confirm I want to {dangerFlow?.kind === "void" ? "void this transaction" : "delete this invoice"}.
          </span>
        </label>
      </Modal>

      <Modal
        open={modal === "inv"}
        title="Create sales invoice"
        onClose={() => setModal(null)}
        onSave={saveInvoiceFromModal}
        saveDisabled={acctRole === "Viewer"}
        saveLabel={acctRole === "Viewer" ? "View-only" : "Save invoice"}
      >
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 11 }}>
          <F label="Invoice #">
            <input value={ni.num} onChange={e => setNi(p => ({ ...p, num: e.target.value }))} style={IS} />
          </F>
          <F label="Invoice date">
            <input
              type="date"
              value={ni.date}
              onChange={e => setNi(p => ({ ...p, date: e.target.value, dueDate: addDaysISO(e.target.value, parseInt(p.dueDays, 10) || 30) }))}
              style={IS}
            />
          </F>
          <F label="Payment due (days)">
            <input
              type="number"
              min={0}
              value={ni.dueDays}
              onChange={e =>
                setNi(p => ({
                  ...p,
                  dueDays: e.target.value,
                  dueDate: addDaysISO(p.date, parseInt(e.target.value, 10) || 30),
                }))
              }
              style={IS}
            />
          </F>
          <F label="Due date">
            <input type="date" value={ni.dueDate} onChange={e => setNi(p => ({ ...p, dueDate: e.target.value }))} style={IS} />
          </F>
          <div style={{ gridColumn: "1/-1" }}>
            <F label="Bill to (client)">
              <input value={ni.client} onChange={e => setNi(p => ({ ...p, client: e.target.value }))} placeholder="Legal name as on PO / contract" style={IS} />
            </F>
          </div>
          <F label="Client GSTIN">
            <input value={ni.gstin} onChange={e => setNi(p => ({ ...p, gstin: e.target.value }))} placeholder="29AAACS1234F1Z0" style={IS} />
          </F>
          <F label="Place of supply">
            <select value={ni.place} onChange={e => setNi(p => ({ ...p, place: e.target.value }))} style={IS}>
              <option value="intra">Intra-state (CGST + SGST)</option>
              <option value="inter">Inter-state (IGST)</option>
            </select>
          </F>
          <F label="SAC">
            <input value={ni.sac} onChange={e => setNi(p => ({ ...p, sac: e.target.value }))} placeholder="998314" style={IS} />
          </F>
          <F label="Revenue category (ledger)">
            <select value={ni.revenueCategory} onChange={e => setNi(p => ({ ...p, revenueCategory: e.target.value }))} style={IS}>
              {REVENUE_CATS.map(c => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </F>
          <F label="Taxable value (₹, excl. GST)">
            <input type="number" value={ni.taxable} onChange={e => setNi(p => ({ ...p, taxable: e.target.value }))} placeholder="0" style={IS} />
          </F>
          <F label="GST rate">
            <select value={ni.gst_rate} onChange={e => setNi(p => ({ ...p, gst_rate: e.target.value }))} style={IS}>
              <option value="18">18%</option>
              <option value="12">12%</option>
              <option value="5">5%</option>
              <option value="0">0% (nil / export)</option>
            </select>
          </F>
          {(() => {
            const g = computeInvoiceGst(ni.taxable, ni.gst_rate, ni.place)
            return (
              <>
                {ni.place === "inter" ? (
                  <F label="IGST (₹)">
                    <input readOnly value={g.igst} style={{ ...IS, opacity: 0.75 }} />
                  </F>
                ) : (
                  <>
                    <F label="CGST (₹)">
                      <input readOnly value={g.cgst} style={{ ...IS, opacity: 0.75 }} />
                    </F>
                    <F label="SGST (₹)">
                      <input readOnly value={g.sgst} style={{ ...IS, opacity: 0.75 }} />
                    </F>
                  </>
                )}
                <div style={{ gridColumn: "1/-1" }}>
                  <F label="Invoice total (₹)">
                    <input readOnly value={g.total} style={{ ...IS, opacity: 0.85, fontWeight: 700 }} />
                  </F>
                </div>
              </>
            )
          })()}
          <div style={{ gridColumn: "1/-1" }}>
            <F label="Description (optional)">
              <textarea value={ni.desc} onChange={e => setNi(p => ({ ...p, desc: e.target.value }))} placeholder="Line items / period / PO reference…" style={{ ...IS, resize: "none", minHeight: 52 }} />
            </F>
          </div>
          <div style={{ gridColumn: "1/-1" }}>
            <F label="Internal notes">
              <input value={ni.notes} onChange={e => setNi(p => ({ ...p, notes: e.target.value }))} placeholder="Not shown on PDF" style={IS} />
            </F>
          </div>
        </div>
      </Modal>

      <Modal
        open={invPayId != null}
        title="Record payment"
        onClose={() => {
          setInvPayId(null)
          setInvPayAmt("")
          setInvPayTds("")
        }}
        onSave={applyInvoicePaymentModal}
        saveDisabled={acctRole === "Viewer"}
        saveLabel="Apply payment"
      >
        <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 12 }}>
          {(() => {
            const t = invoices.find(i => i.id === invPayId)
            if (!t) return "—"
            return (
              <>
                Invoice <strong style={{ color: "#0c4a6e" }}>{t.num}</strong> · Balance due ₹{inr(invoiceBalance(t))}
              </>
            )
          })()}
        </div>
        <F label="Credited to bank (₹)">
          <input type="number" value={invPayAmt} onChange={e => setInvPayAmt(e.target.value)} style={IS} placeholder="Net received in CA" />
        </F>
        <F label="TDS deducted by client (₹) — optional">
          <input type="number" value={invPayTds} onChange={e => setInvPayTds(e.target.value)} style={IS} placeholder="0 if none" />
        </F>
        {(() => {
          const t = invoices.find(i => i.id === invPayId)
          if (!t) return null
          const bal = invoiceBalance(t)
          const recv = Math.round((parseFloat(String(invPayAmt).replace(/,/g, "")) || 0) * 100) / 100
          const tds = Math.round((parseFloat(String(invPayTds).replace(/,/g, "")) || 0) * 100) / 100
          const settle = Math.round((recv + tds) * 100) / 100
          const rem = Math.round((bal - settle) * 100) / 100
          return (
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 4, padding: "8px 10px", background: "#ffffff", borderRadius: 8, border: "1px solid #bae6fd", lineHeight: 1.5 }}>
              <strong style={{ color: "#94a3b8" }}>Settlement toward invoice:</strong> ₹{inr(recv)} bank + ₹{inr(tds)} TDS ={" "}
              <strong style={{ color: "#0c4a6e" }}>₹{inr(settle)}</strong>
              <br />
              After apply, balance due ≈ ₹{inr(Math.max(0, rem))}
              {settle > bal + 0.01 ? <span style={{ color: "#f59e0b" }}> · Excess is trimmed to match open balance.</span> : null}
            </div>
          )
        })()}
      </Modal>

      <Modal open={modal==="emp"} title="Add Employee" onClose={()=>setModal(null)} onSave={()=>{toast_("✓ Employee added");setModal(null)}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:11}}>
          <div style={{gridColumn:"1/-1"}}><F label="Full Name"><input placeholder="Employee full name" style={IS}/></F></div>
          <F label="Department"><select style={IS}><option>Operations</option><option>Technology</option><option>Sales</option><option>HR</option></select></F>
          <F label="Employee ID"><input placeholder="QH-013" style={IS}/></F>
          <F label="Basic Salary (₹/mo)"><input type="number" placeholder="0" style={IS}/></F>
          <F label="PAN Number"><input placeholder="ABCDE1234F" style={IS}/></F>
          <F label="Tax Regime"><select style={IS}><option>New Regime</option><option>Old Regime</option></select></F>
          <F label="Bank IFSC"><input placeholder="HDFC0001234" style={IS}/></F>
          <div style={{gridColumn:"1/-1"}}><F label="Bank Account No."><input placeholder="XXXXXXXXXXXX" style={IS}/></F></div>
        </div>
      </Modal>

      <Modal open={modal==="item"} title="Add Inventory Item" onClose={()=>setModal(null)} onSave={()=>{toast_("✓ Item added");setModal(null)}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:11}}>
          <div style={{gridColumn:"1/-1"}}><F label="Item Name"><input placeholder="e.g. MacBook Pro 14&quot;" style={IS}/></F></div>
          <F label="HSN / SAC Code"><input placeholder="84713010" style={IS}/></F>
          <F label="Category"><select style={IS}><option>Hardware</option><option>Software License</option><option>Office Asset</option></select></F>
          <F label="Quantity"><input type="number" defaultValue="1" style={IS}/></F>
          <F label="Unit Value (₹)"><input type="number" placeholder="0" style={IS}/></F>
          <F label="Vendor"><input placeholder="Vendor name" style={IS}/></F>
          <F label="Purchase Date"><input type="date" defaultValue="2026-03-20" style={IS}/></F>
        </div>
      </Modal>
    </div>
  )
}
