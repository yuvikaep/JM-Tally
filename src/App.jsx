import { useState, useEffect, useRef, useCallback, useMemo, Fragment } from "react"
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
  fyPrevYearEndDdMmYyyy,
  lastCalendarMonthEndDdMmYyyy,
  bankBalanceOnOrBeforeDate,
  draftInvoiceSettlementTxns,
  stripInvoiceSettlementTxns,
  BANK_ACCOUNT,
} from "./accountingEngine.js"
import {
  bankFileToImportMatrix,
  importBankStatementFromMatrix,
  isTxnFromBankFileImport,
  inferDebitCategoryFromBankText,
} from "./bankStatementImport.js"
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
import { createScopedStore } from "./authStorage.js"
import { useAuth } from "./auth/AuthContext.jsx"
import { AuthRouter } from "./auth/AuthRouter.jsx"
import authStyles from "./auth/auth.module.css"
import {
  DEFAULT_AUTOMATION_SKILLS,
  coerceAutomationSkills,
  applyCategorizationSkills,
  newCustomSkillId,
  isValidTemplateSkill,
  isValidCategorizeSkill,
} from "./automationSkills.js"
import { matchEnterpriseAgentQuery, getAgentSkillsOverviewMarkdown, tryEmbeddedAgentHelp } from "./accountingAgentTraining.js"
import { tryNaturalLanguageJournal, tryGstPaymentJournalFromChat } from "./journalFromNaturalLanguage.js"
import { parseBulkSalaryPaste, bulkSalaryRowsToConfirmEntries } from "./bulkSalaryPaste.js"

const AUTOMATION_DEFAULT_IDS = new Set(DEFAULT_AUTOMATION_SKILLS.map(s => s.id))

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
  "Employer PF / ESI Expense",
  "Rent Expense",
  "Electricity Expense",
  "Food Expense",
  "Travel Expense",
  "Salary Income",
  "Recruitment - Job Portals",
  "Vendor - Supplies",
  "Vendor - IT Solutions",
  "Vendor - Professional",
  "Vendor - Other",
  "Capital Infusion - Director",
  "Capital Infusion - Cash",
  "Bank Charges",
  "GST Payment (Output Tax)",
  "Income Tax Refund",
  "NEFT Return",
  "Misc Expense",
  "Misc Income",
  "Payment Gateway",
]
const REVENUE_CATS = CATS.filter(c => c.startsWith("Revenue"))

/** Map Add Transaction UI (Debit/Credit) to bank journal side. */
function ntDrCrToBank(ntDrCr) {
  const s = String(ntDrCr || "Debit")
  return s.startsWith("C") || s.toUpperCase() === "CR" ? "CR" : "DR"
}

/** Recent unique narrations for this category + type (Debit/Credit), newest first. */
function collectTxnParticularsSuggestions(txns, category, ntDrCr) {
  const bank = ntDrCrToBank(ntDrCr)
  const cat = String(category || "").trim()
  const seen = new Set()
  const out = []
  const list = [...(txns || [])].filter(t => !t.void && String(t.category || "") === cat && t.drCr === bank)
  list.sort((a, b) => parseDdMmYyyy(b.date) - parseDdMmYyyy(a.date) || b.id - a.id)
  for (const t of list) {
    const p = String(t.particulars || "").trim()
    if (!p || seen.has(p)) continue
    seen.add(p)
    out.push(p)
    if (out.length >= 32) break
  }
  return out
}

function defaultTxnNarrationForCategory(category, ntDrCr) {
  const cat = String(category || "Misc Expense").trim() || "Misc Expense"
  return ntDrCrToBank(ntDrCr) === "CR" ? `Bank credit — ${cat}` : `Bank debit — ${cat}`
}

/** Prefer last matching narration; else a short template from category + type. */
function pickSuggestedParticulars(txns, category, ntDrCr) {
  const hist = collectTxnParticularsSuggestions(txns, category, ntDrCr)
  if (hist.length) return hist[0]
  return defaultTxnNarrationForCategory(category, ntDrCr)
}

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
    else if (u.drCr === "DR" && u.category === "Misc Expense") {
      const inferred = inferDebitCategoryFromBankText(u.particulars || "", u.bankRemark || "")
      if (inferred) u = { ...u, category: inferred }
    }
    return u
  })

/** After category rules, rebuild journal lines so TB / P&L stay consistent */
function applyLedgerCategoryNormalization(txns) {
  if (!Array.isArray(txns)) return []
  const n = normalizeTxnCategories(txns.map(t => ({ ...t })))
  return n.map(t => enrichTxnJournal({ ...t, journalLines: undefined }))
}

/**
 * Remove all auto-posted settlement lines for this invoice, then re-post one pair
 * from current `paidBankTotal` / `paidTdsTotal` so ledger matches the invoice row.
 * Used after invoice edit. Delete uses the same path with zero payment (strip only).
 */
function syncLedgerWithInvoicePaymentState(txns, inv, opt) {
  const stripped = stripInvoiceSettlementTxns(txns, inv.id)
  const bank = Math.round((Number(inv.paidBankTotal ?? inv.paidAmount) || 0) * 100) / 100
  const tds = Math.round((Number(inv.paidTdsTotal) || 0) * 100) / 100
  if (bank <= 0.005 && tds <= 0.005) {
    return withRecalculatedBalances(applyLedgerCategoryNormalization(stripped))
  }
  const dateDdMmYyyy = inv.paidAt ? isoToDdMmYyyy(inv.paidAt) : isoToDdMmYyyy(inv.date)
  const res = draftInvoiceSettlementTxns({
    prevTxns: stripped,
    inv,
    incBank: bank,
    incTds: tds,
    dateDdMmYyyy,
  })
  if (res.error) {
    return withRecalculatedBalances(applyLedgerCategoryNormalization(stripped))
  }
  const createdAt = new Date().toISOString()
  const by = (opt && opt.createdBy) || "Invoice"
  const stamped = res.drafts.map(d => ({
    ...d,
    audit: { ...d.audit, createdAt, createdBy: by },
  }))
  return withRecalculatedBalances(applyLedgerCategoryNormalization([...stripped, ...stamped]))
}

function ledgerVisualChanged(prev, next) {
  if (!Array.isArray(prev) || !Array.isArray(next) || prev.length !== next.length) return true
  const pmap = Object.fromEntries(prev.map(t => [t.id, t]))
  return next.some(t => {
    const p = pmap[t.id]
    if (!p) return true
    if (p.category !== t.category) return true
    return JSON.stringify(p.journalLines) !== JSON.stringify(t.journalLines)
  })
}

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

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** Merge line item title + detail into stored `desc` */
function combineInvoiceDesc(ni) {
  const a = String(ni.itemName || "").trim()
  const b = String(ni.desc || "").trim()
  if (a && b) return `${a}\n${b}`
  return a || b
}

/** Reverse of combineInvoiceDesc for edit / legacy rows */
function splitStoredInvoiceDesc(stored) {
  const raw = String(stored || "")
  const nl = raw.indexOf("\n")
  if (nl < 0) return { itemName: raw.trim(), descExtra: "" }
  return { itemName: raw.slice(0, nl).trim(), descExtra: raw.slice(nl + 1).trim() }
}

const _w1 = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"]
const _w10 = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]

function wordsUnder100(n) {
  if (n < 20) return _w1[n]
  const t = Math.floor(n / 10)
  const o = n % 10
  return _w10[t] + (o ? " " + _w1[o] : "")
}

function wordsUnder1000(n) {
  if (n < 100) return wordsUnder100(n)
  const h = Math.floor(n / 100)
  const r = n % 100
  return _w1[h] + " Hundred" + (r ? " " + wordsUnder100(r) : "")
}

/** Whole rupees only — for print footer */
function inrAmountWords(n) {
  const x = Math.floor(Math.abs(Number(n) || 0))
  if (x === 0) return "Zero Rupees Only"
  if (x >= 100000000) return "Indian Rupees " + inr(x) + " (as per figures)"
  let rem = x
  const crore = Math.floor(rem / 10000000)
  rem %= 10000000
  const lakh = Math.floor(rem / 100000)
  rem %= 100000
  const thousand = Math.floor(rem / 1000)
  rem %= 1000
  const parts = []
  if (crore) parts.push(wordsUnder1000(crore) + " Crore")
  if (lakh) parts.push(wordsUnder1000(lakh) + " Lakh")
  if (thousand) parts.push(wordsUnder1000(thousand) + " Thousand")
  if (rem) parts.push(wordsUnder1000(rem))
  return parts.join(" ") + " Rupees Only"
}

function formatIsoNice(iso) {
  if (!iso) return "—"
  const d = new Date(String(iso).includes("T") ? iso : `${iso}T12:00:00`)
  if (!Number.isFinite(d.getTime())) return String(iso)
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
}

/**
 * Print HTML invoice/PDF preview. Do not pass `noopener` to window.open — it makes the return value null
 * so document.write cannot run. Falls back to a hidden iframe when pop-ups are blocked.
 */
function printHtmlDocument(html) {
  const w = window.open("", "_blank")
  if (w && w.document) {
    try {
      w.document.open()
      w.document.write(html)
      w.document.close()
      w.focus()
      setTimeout(() => {
        try {
          w.print()
        } catch (_) {
          /* ignore */
        }
      }, 250)
      return true
    } catch (_) {
      try {
        w.close()
      } catch (_) {
        /* ignore */
      }
    }
  }
  try {
    const iframe = document.createElement("iframe")
    iframe.setAttribute("title", "Print invoice")
    iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:none;opacity:0;pointer-events:none"
    document.body.appendChild(iframe)
    const win = iframe.contentWindow
    const doc = win.document
    doc.open()
    doc.write(html)
    doc.close()
    win.focus()
    setTimeout(() => {
      try {
        win.print()
      } catch (_) {
        /* ignore */
      }
      setTimeout(() => {
        try {
          iframe.remove()
        } catch (_) {
          /* ignore */
        }
      }, 1500)
    }, 150)
    return true
  } catch (_) {
    return false
  }
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
  const qRaw = Number(inv.qty)
  const qty = Number.isFinite(qRaw) && qRaw > 0 ? qRaw : 1
  return {
    id: inv.id,
    num: String(inv.num || ""),
    date: inv.date || todayISO(),
    dueDate: inv.dueDate || inv.date || todayISO(),
    client: String(inv.client || ""),
    gstin: String(inv.gstin || ""),
    sac: String(inv.sac || "998314"),
    qty,
    taxable: t,
    gst_rate: g,
    cgst,
    sgst,
    igst,
    total,
    desc: String(inv.desc || ""),
    subtitle: String(inv.subtitle || ""),
    place,
    revenueCategory: inv.revenueCategory || REVENUE_CATS[0] || "Revenue - B2B Services",
    notes: String(inv.notes || ""),
    status: inv.status || "sent",
    paidAmount: Math.min(paidAmount, cap),
    paidBankTotal,
    paidTdsTotal,
    paidAt: inv.paidAt || "",
    createdAt: inv.createdAt || new Date().toISOString(),
    clientAddress: String(inv.clientAddress || ""),
    clientPan: String(inv.clientPan || ""),
  }
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Literal prefix before the numeric tail, e.g. `JM-2026-` → `JM-2026-0001`. */
function normalizeInvoiceSeriesPrefix(raw) {
  let p = String(raw ?? "").trim()
  if (!p) p = "INV-"
  if (p === "INV") p = "INV-"
  return p
}

/**
 * Next invoice # = prefix + 4-digit sequence (include year etc. in the prefix if you want, e.g. JM-2026-).
 * Prefix match is case-insensitive via RegExp (avoids slice bugs when casing differs from stored invoices).
 * If the company prefix matches no invoice, infers prefix from the latest invoice # (by id) so series stays in sync.
 */
function inferInvoicePrefixFromLatestInvoice(list) {
  const sorted = [...(list || [])]
    .filter(x => String(x.num || "").trim())
    .sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0))
  const raw = String(sorted[0]?.num || "").trim()
  if (!raw) return null
  const m = raw.match(/^(.*?)(\d{4,})$/) || raw.match(/^(.*?)(\d+)$/)
  if (!m || m[1] == null) return null
  return m[1]
}

function suggestNextInvoiceNum(list, seriesPrefix) {
  const pfxConfigured = normalizeInvoiceSeriesPrefix(seriesPrefix)
  const computeMax = pfx => {
    let max = 0
    let any = false
    for (const inv of list || []) {
      const raw = String(inv.num || "").trim()
      if (!raw) continue
      let re
      try {
        re = new RegExp(`^${escapeRegExp(pfx)}`, "i")
      } catch {
        continue
      }
      const m = raw.match(re)
      if (!m) continue
      any = true
      const rest = raw.slice(m[0].length).trim()
      const digitGroups = rest.match(/\d+/g)
      if (!digitGroups?.length) continue
      const n = parseInt(digitGroups[digitGroups.length - 1], 10)
      if (Number.isFinite(n)) max = Math.max(max, n)
    }
    return { max, any }
  }
  let { max, any } = computeMax(pfxConfigured)
  let pfx = pfxConfigured
  if (!any && (list || []).length > 0) {
    const inferred = inferInvoicePrefixFromLatestInvoice(list)
    if (inferred) {
      const p2 = normalizeInvoiceSeriesPrefix(inferred)
      const r2 = computeMax(p2)
      max = r2.max
      pfx = p2
    }
  }
  return `${pfx}${String(max + 1).padStart(4, "0")}`
}

/** Pre-GST line amount from qty × unit rate (qty defaults to 1). */
function parseInvoiceQty(raw) {
  const q = parseFloat(String(raw ?? "1").replace(/,/g, ""))
  if (!Number.isFinite(q) || q <= 0) return 1
  return q
}

function lineTaxableFromNi(ni) {
  const qty = parseInvoiceQty(ni?.qty)
  const r = parseFloat(String(ni?.unitRate ?? "").replace(/,/g, "")) || 0
  return Math.round(qty * r * 100) / 100
}

/** Suggest payment terms from the most recent invoice to the same client (name + GSTIN). */
function suggestDueFromLastClientInvoice(invoices, clientName, gstin, invoiceDateIso) {
  const key = clientKeyInv({ client: clientName, gstin })
  if (!String(clientName || "").trim()) return null
  let best = null
  for (const inv of invoices || []) {
    if (clientKeyInv(inv) !== key) continue
    const ts = String(inv.createdAt || inv.date || "")
    if (!best || ts >= best._ts) best = { inv, _ts: ts }
  }
  if (!best) return null
  const d0 = Date.parse(best.inv.date)
  const d1 = Date.parse(best.inv.dueDate || best.inv.date)
  if (!Number.isFinite(d0) || !Number.isFinite(d1)) return null
  const dd = Math.max(0, Math.round((d1 - d0) / 86400000))
  return {
    dueDays: String(dd),
    dueDate: addDaysISO(invoiceDateIso, dd),
  }
}

/** One row per distinct client+GSTIN from past invoices (latest row wins for defaults). */
function invoiceClientPresetsFromList(invoices) {
  const map = new Map()
  for (const inv of invoices || []) {
    const name = String(inv.client || "").trim()
    if (!name) continue
    const gst = String(inv.gstin || "").trim().toUpperCase()
    const key = `${name.toLowerCase()}\n${gst}`
    const ts = String(inv.createdAt || inv.date || "")
    const prev = map.get(key)
    if (!prev || ts >= prev._ts) {
      map.set(key, {
        key,
        client: name,
        gstin: String(inv.gstin || "").trim(),
        place: inv.place === "inter" ? "inter" : "intra",
        sac: String(inv.sac || "998314").trim(),
        revenueCategory: inv.revenueCategory || REVENUE_CATS[0] || "Revenue - B2B Services",
        clientAddress: String(inv.clientAddress || "").trim(),
        clientPan: String(inv.clientPan || "").trim(),
        _ts: ts,
      })
    }
  }
  return [...map.values()]
    .map(entry => ({
      key: entry.key,
      client: entry.client,
      gstin: entry.gstin,
      place: entry.place,
      sac: entry.sac,
      revenueCategory: entry.revenueCategory,
      clientAddress: entry.clientAddress || "",
      clientPan: entry.clientPan || "",
    }))
    .sort((a, b) => a.client.localeCompare(b.client, undefined, { sensitivity: "base" }))
}

function manualClientKey(m) {
  if (!m) return ""
  return `${String(m.client || "").trim().toLowerCase()}\n${String(m.gstin || "").trim().toUpperCase()}`
}

function clientKeyInv(inv) {
  if (!inv) return ""
  return `${String(inv.client || "").trim().toLowerCase()}\n${String(inv.gstin || "").trim().toUpperCase()}`
}

function manualClientToDraft(m) {
  const n = normalizeManualClients([m])[0]
  return {
    client: n.client,
    clientIndustry: n.clientIndustry,
    country: n.country,
    city: n.city,
    logoDataUrl: n.logoDataUrl,
    gstin: n.gstin,
    place: n.place,
    pan: n.pan,
    addrLine1: n.addrLine1,
    addrLine2: n.addrLine2,
    state: n.state,
    pin: n.pin,
    shipLine1: n.shipLine1,
    shipLine2: n.shipLine2,
    shipState: n.shipState,
    shipPin: n.shipPin,
    shipSame: n.shipSame,
    additionalNotes: n.additionalNotes,
    bankName: n.bankName,
    accountNumber: n.accountNumber,
    ifsc: n.ifsc,
    creditLimit: n.creditLimit,
  }
}

function presetToAddClientDraft(p) {
  if (!p) return emptyAddClientDraft()
  return {
    ...emptyAddClientDraft(),
    client: p.client,
    gstin: p.gstin,
    place: p.place || "intra",
  }
}

function emptyAddClientDraft() {
  return {
    client: "",
    clientIndustry: "",
    country: "India",
    city: "",
    logoDataUrl: "",
    gstin: "",
    place: "intra",
    pan: "",
    addrLine1: "",
    addrLine2: "",
    state: "",
    pin: "",
    shipLine1: "",
    shipLine2: "",
    shipState: "",
    shipPin: "",
    shipSame: true,
    additionalNotes: "",
    bankName: "",
    accountNumber: "",
    ifsc: "",
    creditLimit: "",
  }
}

/** Directory entries added from Clients page (no invoice yet). Merged into invoice presets for dropdowns. */
function normalizeManualClients(arr) {
  if (!Array.isArray(arr)) return []
  return arr
    .filter(x => x && typeof x === "object" && String(x.client || "").trim())
    .map((x, i) => ({
      id: Number(x.id) > 0 ? Number(x.id) : i + 1,
      client: String(x.client || "").trim(),
      gstin: String(x.gstin || "").trim(),
      place: x.place === "inter" ? "inter" : "intra",
      createdAt: x.createdAt || new Date().toISOString(),
      clientIndustry: String(x.clientIndustry || ""),
      country: String(x.country || "India"),
      city: String(x.city || ""),
      logoDataUrl: typeof x.logoDataUrl === "string" ? x.logoDataUrl : "",
      pan: String(x.pan || ""),
      addrLine1: String(x.addrLine1 || ""),
      addrLine2: String(x.addrLine2 || ""),
      state: String(x.state || ""),
      pin: String(x.pin || ""),
      shipLine1: String(x.shipLine1 || ""),
      shipLine2: String(x.shipLine2 || ""),
      shipState: String(x.shipState || ""),
      shipPin: String(x.shipPin || ""),
      shipSame: x.shipSame !== false,
      additionalNotes: String(x.additionalNotes || ""),
      bankName: String(x.bankName || ""),
      accountNumber: String(x.accountNumber || ""),
      ifsc: String(x.ifsc || ""),
      creditLimit: String(x.creditLimit || ""),
    }))
}

function mergeManualClientsIntoPresets(manualClients, invoicePresets) {
  const map = new Map()
  for (const p of invoicePresets || []) {
    map.set(p.key, { ...p })
  }
  const defCat = REVENUE_CATS[0] || "Revenue - B2B Services"
  for (const m of normalizeManualClients(manualClients)) {
    const name = String(m.client || "").trim()
    if (!name) continue
    const gst = String(m.gstin || "").trim().toUpperCase()
    const key = `${name.toLowerCase()}\n${gst}`
    if (!map.has(key)) {
      map.set(key, {
        key,
        client: name,
        gstin: String(m.gstin || "").trim(),
        place: m.place === "inter" ? "inter" : "intra",
        sac: "998314",
        revenueCategory: defCat,
      })
    }
  }
  return [...map.values()].sort((a, b) => a.client.localeCompare(b.client, undefined, { sensitivity: "base" }))
}

/** Registry row: company identity + invoice “Billed by” block (persisted per workspace). */
function emptyCompanyFormDraft() {
  return {
    name: "",
    legalName: "",
    bankAccountLabel: "",
    bankName: "",
    bankAccountName: "",
    bankAccountNumber: "",
    bankIfsc: "",
    bankAccountType: "",
    logoDataUrl: "",
    addrLine1: "",
    addrLine2: "",
    city: "",
    state: "",
    country: "India",
    pin: "",
    gstin: "",
    pan: "",
    currency: "INR",
    invoiceSeriesPrefix: "INV-",
    invoiceFooterEmail: "",
    invoiceFooterPhone: "",
  }
}

function normalizeCompanyRecord(c) {
  if (!c || typeof c !== "object" || !c.id) return null
  return {
    id: c.id,
    name: String(c.name || "").trim() || "Company",
    legalName: String(c.legalName || "").trim(),
    bankAccountLabel: String(c.bankAccountLabel || "").trim(),
    bankName: String(c.bankName || "").trim(),
    bankAccountName: String(c.bankAccountName || "").trim(),
    bankAccountNumber: String(c.bankAccountNumber || "").trim(),
    bankIfsc: String(c.bankIfsc || "").trim(),
    bankAccountType: String(c.bankAccountType || "").trim(),
    logoDataUrl: typeof c.logoDataUrl === "string" ? c.logoDataUrl : "",
    addrLine1: String(c.addrLine1 || "").trim(),
    addrLine2: String(c.addrLine2 || "").trim(),
    city: String(c.city || "").trim(),
    state: String(c.state || "").trim(),
    country: String(c.country || "India").trim() || "India",
    pin: String(c.pin || "").trim(),
    gstin: String(c.gstin || "").trim(),
    pan: String(c.pan || "").trim(),
    currency: String(c.currency || "INR").trim() || "INR",
    invoiceSeriesPrefix: normalizeInvoiceSeriesPrefix(c.invoiceSeriesPrefix),
    invoiceFooterEmail: String(c.invoiceFooterEmail || "").trim(),
    invoiceFooterPhone: String(c.invoiceFooterPhone || "").trim(),
  }
}

function companyFromRegistry(c) {
  const n = normalizeCompanyRecord(c)
  if (!n) return emptyCompanyFormDraft()
  return {
    name: n.name,
    legalName: n.legalName,
    bankAccountLabel: n.bankAccountLabel,
    bankName: n.bankName,
    bankAccountName: n.bankAccountName,
    bankAccountNumber: n.bankAccountNumber,
    bankIfsc: n.bankIfsc,
    bankAccountType: n.bankAccountType,
    logoDataUrl: n.logoDataUrl,
    addrLine1: n.addrLine1,
    addrLine2: n.addrLine2,
    city: n.city,
    state: n.state,
    country: n.country,
    pin: n.pin,
    gstin: n.gstin,
    pan: n.pan,
    currency: n.currency,
    invoiceSeriesPrefix: n.invoiceSeriesPrefix,
    invoiceFooterEmail: n.invoiceFooterEmail,
    invoiceFooterPhone: n.invoiceFooterPhone,
  }
}

function formatCompanyAddressForInvoice(co) {
  if (!co) return ""
  const street = [co.addrLine1, co.addrLine2].map(s => String(s || "").trim()).filter(Boolean).join(", ")
  const cs = [co.city, co.state].map(s => String(s || "").trim()).filter(Boolean).join(", ")
  const pin = String(co.pin || "").trim()
  const ctry = String(co.country || "").trim()
  const parts = []
  if (street) parts.push(street)
  if (cs) parts.push(cs)
  if (ctry || pin) {
    if (ctry && pin) parts.push(`${ctry} - ${pin}`)
    else parts.push(ctry || pin)
  }
  return parts.join(", ")
}

/** Registered address for manual client directory — same rules as company block. */
function formatManualClientAddressForInvoice(m) {
  if (!m) return ""
  const street = [m.addrLine1, m.addrLine2].map(s => String(s || "").trim()).filter(Boolean).join(", ")
  const cs = [m.city, m.state].map(s => String(s || "").trim()).filter(Boolean).join(", ")
  const pin = String(m.pin || "").trim()
  const ctry = String(m.country || "").trim() || "India"
  const parts = []
  if (street) parts.push(street)
  if (cs) parts.push(cs)
  if (ctry || pin) {
    if (ctry && pin) parts.push(`${ctry} - ${pin}`)
    else parts.push(ctry || pin)
  }
  return parts.join(", ")
}

/** Amount in words including paise (e.g. tax line). Uppercase for print. */
function inrAmountWordsPaise(n) {
  const x = Math.round((Math.abs(Number(n) || 0) + Number.EPSILON) * 100) / 100
  const rupees = Math.floor(x)
  const paise = Math.round((x - rupees) * 100)
  const base = inrAmountWords(rupees).replace(/\s+Rupees Only$/i, "").trim()
  if (paise <= 0) return `${base.toUpperCase()} RUPEES ONLY`
  const pw = wordsUnder100(paise).toUpperCase()
  return `${base.toUpperCase()} RUPEES AND ${pw} PAISE ONLY`
}

function invoiceCurrencyLabel(code) {
  const c = String(code || "INR").toUpperCase()
  if (c === "INR") return "INR (₹)"
  if (c === "USD") return "USD ($)"
  if (c === "EUR") return "EUR (€)"
  if (c === "GBP") return "GBP (£)"
  if (c === "AED") return "AED (AED)"
  return c
}

function safeInvoiceLogoSrc(url) {
  if (typeof url !== "string" || !url.startsWith("data:image/")) return ""
  return url
}

/** Shared CSS for print/PDF — Jobsmato-style: white, lavender cards, indigo table header. */
const INVOICE_PRINT_STYLESHEET = `
body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:#ffffff;color:#1e1b4b;font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased;}
.inv-wrap{max-width:960px;margin:0 auto;padding:24px 28px 36px;}
.inv-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:18px;gap:20px;flex-wrap:wrap;}
.inv-head-left{flex:1;min-width:200px;}
.inv-head-right{flex-shrink:0;}
.inv-title{margin:0 0 10px;font-size:30px;font-weight:800;color:#5b21b6;letter-spacing:-0.03em;}
.inv-meta-list{font-size:12px;color:#4338ca;line-height:1.65;}
.inv-meta-list strong{color:#312e81;font-weight:700;margin-right:6px;}
.inv-submeta{font-size:11px;color:#64748b;margin-top:4px;}
.inv-logo{max-height:56px;max-width:240px;object-fit:contain;}
.sub{color:#64748b;font-size:13px;margin:8px 0 16px;font-weight:500;}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:20px;}
.card{border:1px solid #e9d5ff;border-radius:12px;padding:16px 18px;background:linear-gradient(180deg,#faf5ff 0%,#f5f3ff 100%);box-shadow:0 1px 4px rgba(91,33,182,.08);}
.lbl{font-size:10px;text-transform:uppercase;color:#6b7280;font-weight:700;letter-spacing:.09em;margin-bottom:8px;}
.bill-name{font-weight:700;font-size:15px;color:#312e81;}
.bill-addr{font-size:12px;color:#334155;margin-top:8px;line-height:1.55;}
.bill-tax{font-size:12px;margin-top:6px;color:#334155;}
.bank-tot-grid{display:grid;grid-template-columns:1fr 300px;gap:18px;margin-top:22px;align-items:start;}
.bank-card{margin:0;}
.bank-box{font-size:11px;color:#334155;line-height:1.65;}
.bank-lbl{font-size:10px;font-weight:700;color:#5b21b6;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;}
.bill-to-name{font-weight:700;font-size:15px;color:#312e81;}
.bill-to-addr{font-size:12px;color:#334155;margin-top:8px;line-height:1.55;}
.bill-to-sub{font-size:12px;margin-top:6px;color:#334155;}
.hsn-inline{font-size:11px;color:#6b7280;font-weight:500;}
table.inv-table{width:100%;border-collapse:separate;border-spacing:0;margin-top:12px;font-size:11px;border:1px solid #c4b5fd;border-radius:10px;overflow:hidden;}
.inv-table thead th{background:#312e81;color:#ffffff;padding:11px 8px;font-weight:700;border-bottom:1px solid #1e1b4b;text-align:left;}
.inv-table th.num,.inv-table td.num{text-align:right;}
.inv-table tbody td{padding:10px 8px;border-bottom:1px solid #e9d5ff;background:#faf5ff;}
.inv-table tbody tr:last-child td{border-bottom:none;}
.td-item{vertical-align:top;}
.td-sub{font-size:11px;color:#64748b;margin-top:4px;line-height:1.4;}
.tot{border:1px solid #e9d5ff;border-radius:12px;padding:16px 20px;background:linear-gradient(180deg,#ffffff 0%,#faf5ff 100%);box-shadow:0 2px 12px rgba(91,33,182,.06);}
.totline{display:flex;justify-content:space-between;gap:24px;margin:6px 0;font-size:12px;color:#334155;}
.totline-strong{font-weight:800;font-size:16px;color:#312e81;padding-top:10px;margin-top:8px;border-top:3px double #c4b5fd;}
.words{margin-top:18px;font-size:12px;color:#475569;}
.tax-table{width:100%;border-collapse:collapse;margin-top:22px;font-size:11px;border:2px solid #0f172a;}
.tax-table th,.tax-table td{border:1px solid #0f172a;padding:8px 10px;text-align:left;}
.tax-table thead th{background:#f8fafc;font-weight:700;color:#0f172a;}
.tax-table .num{text-align:right;}
.tax-words{font-size:11px;margin-top:10px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:.02em;}
.inv-foot{margin-top:28px;padding-top:18px;border-top:1px solid #e9d5ff;font-size:12px;color:#334155;text-align:center;line-height:1.5;}
.inv-foot strong{color:#312e81;}
.notes{margin-top:20px;font-size:12px;color:#334155;padding:12px 14px;background:#faf5ff;border-radius:8px;border:1px solid #e9d5ff;}
@media print{body{padding:0;}.inv-wrap{padding:12px 16px 20px;}*{print-color-adjust:exact;-webkit-print-color-adjust:exact;}}
@media (max-width:720px){.bank-tot-grid{grid-template-columns:1fr;}}
`

/** Printed invoice: bank block (below line items, left column). */
function buildInvoiceBankDetailsHtml(n) {
  if (!n) return ""
  const acctName = String(n.bankAccountName || "").trim()
  const bname = String(n.bankName || "").trim()
  const acctNum = String(n.bankAccountNumber || "").trim()
  const ifsc = String(n.bankIfsc || "").trim()
  const typ = String(n.bankAccountType || "").trim()
  const legacy = String(n.bankAccountLabel || "").trim()
  if (!acctName && !bname && !acctNum && !ifsc && !typ && !legacy) return ""
  let html = `<div class="bank-box">`
  html += `<div class="bank-lbl">Bank details</div>`
  if (acctName) html += `<div><strong>Account name:</strong> ${escapeHtml(acctName)}</div>`
  if (acctNum) html += `<div><strong>Account number:</strong> ${escapeHtml(acctNum)}</div>`
  if (ifsc) html += `<div><strong>IFSC:</strong> ${escapeHtml(ifsc)}</div>`
  if (typ) html += `<div><strong>Account type:</strong> ${escapeHtml(typ)}</div>`
  if (bname) html += `<div><strong>Bank:</strong> ${escapeHtml(bname)}</div>`
  if (legacy) html += `<div style="margin-top:6px;font-size:10px;color:#64748b;">${escapeHtml(legacy)}</div>`
  html += `</div>`
  return html
}

function buildInvoicePrintHeaderHtml(co, meta) {
  const n = co ? normalizeCompanyRecord(co) : null
  const logo = n?.logoDataUrl && safeInvoiceLogoSrc(n.logoDataUrl)
  return `<div class="inv-head">
  <div class="inv-head-left">
    <h1 class="inv-title">Invoice</h1>
    <div class="inv-meta-list">
      <div><strong>Invoice No #</strong> ${escapeHtml(String(meta.num))}</div>
      <div><strong>Invoice Date</strong> ${escapeHtml(formatIsoNice(meta.date))}</div>
      <div><strong>Due Date</strong> ${escapeHtml(formatIsoNice(meta.dueDate))}</div>
    </div>
    <div class="inv-submeta">Currency: ${escapeHtml(meta.currencyLabel)} · Place of supply: ${escapeHtml(meta.placeLabel)}</div>
  </div>
  ${logo ? `<div class="inv-head-right"><img src="${logo}" alt="" class="inv-logo" /></div>` : ""}
</div>`
}

function buildInvoicePrintBilledByHtml(co) {
  const n = normalizeCompanyRecord(co)
  if (!n) {
    return `<div class="lbl">Billed by</div><div class="bill-name">Company</div>`
  }
  const displayName = escapeHtml(n.legalName || n.name || "Company")
  const addr = formatCompanyAddressForInvoice(n)
  const gst = n.gstin ? `<div class="bill-tax">GSTIN: ${escapeHtml(n.gstin)}</div>` : ""
  const pan = n.pan ? `<div class="bill-tax">PAN: ${escapeHtml(n.pan)}</div>` : ""
  const addrBlock = addr ? `<div class="bill-addr">${escapeHtml(addr)}</div>` : ""
  return `<div class="lbl">Billed by</div>
    <div class="bill-name">${displayName}</div>
    ${addrBlock}
    ${gst}
    ${pan}`
}

function buildInvoicePrintBilledToHtml({ client, gstin, clientAddress, clientPan }) {
  const name = String(client || "").trim() || "—"
  const addr = String(clientAddress || "").trim()
  const g = String(gstin || "").trim()
  const p = String(clientPan || "").trim()
  return `<div class="lbl">Billed to</div>
    <div class="bill-to-name">${escapeHtml(name)}</div>
    ${addr ? `<div class="bill-to-addr">${escapeHtml(addr).replace(/\n/g, "<br/>")}</div>` : ""}
    ${g ? `<div class="bill-to-sub">GSTIN: ${escapeHtml(g)}</div>` : ""}
    ${p ? `<div class="bill-to-sub">PAN: ${escapeHtml(p)}</div>` : ""}`
}

function buildInvoicePrintFooterHtml(co) {
  const n = normalizeCompanyRecord(co)
  if (!n) return ""
  const em = String(n.invoiceFooterEmail || "").trim()
  const ph = String(n.invoiceFooterPhone || "").trim()
  if (!em && !ph) return ""
  const bits = []
  if (em) bits.push(`via email at <strong>${escapeHtml(em)}</strong>`)
  if (ph) bits.push(`call on <strong>${escapeHtml(ph)}</strong>`)
  const line = `For any enquiry, reach out ${bits.join(", ")}`
  return `<div class="inv-foot">${line}</div>`
}

/**
 * Full printable invoice body (preview + print). `taxable` is pre-GST line amount; `qty` defaults to 1.
 */
function buildInvoicePrintDocumentHtml(opts) {
  const {
    co,
    num,
    date,
    dueDate,
    subtitle,
    place,
    client,
    gstin,
    clientAddress,
    clientPan,
    sac,
    lineLabel,
    lineDetail,
    taxable,
    gstPct,
    g,
    notes,
    qty = 1,
  } = opts
  const placeInter = place === "inter"
  const placeLabel = placeInter ? "Inter-state (IGST)" : "Intra-state (CGST+SGST)"
  const currencyLabel = invoiceCurrencyLabel(co?.currency)
  const sacStr = String(sac || "").trim()
  const itemInner = `${escapeHtml(lineLabel)}${
    sacStr ? ` <span class="hsn-inline">(HSN/SAC: ${escapeHtml(sacStr)})</span>` : ""
  }${lineDetail ? `<div class="td-sub">${escapeHtml(lineDetail).replace(/\n/g, "<br/>")}</div>` : ""}`
  const rateEach = qty > 0 ? taxable / qty : taxable
  const gstRateStr = `${escapeHtml(gstPct)}%`

  let thead = ""
  let row = ""
  if (placeInter) {
    thead = `<tr>
    <th>Item</th><th class="num">GST Rate</th><th class="num">Quantity</th><th class="num">Rate</th><th class="num">Amount</th><th class="num">IGST</th><th class="num">Total</th>
  </tr>`
    row = `<tr>
    <td class="td-item">${itemInner}</td>
    <td class="num">${gstRateStr}</td>
    <td class="num">${escapeHtml(String(qty))}</td>
    <td class="num">${escapeHtml(inr(rateEach))}</td>
    <td class="num">${escapeHtml(inr(taxable))}</td>
    <td class="num">${escapeHtml(inr(g.igst))}</td>
    <td class="num" style="font-weight:700;color:#312e81;">${escapeHtml(inr(g.total))}</td>
  </tr>`
  } else {
    thead = `<tr>
    <th>Item</th><th class="num">GST Rate</th><th class="num">Quantity</th><th class="num">Rate</th><th class="num">Amount</th><th class="num">CGST</th><th class="num">SGST</th><th class="num">Total</th>
  </tr>`
    row = `<tr>
    <td class="td-item">${itemInner}</td>
    <td class="num">${gstRateStr}</td>
    <td class="num">${escapeHtml(String(qty))}</td>
    <td class="num">${escapeHtml(inr(rateEach))}</td>
    <td class="num">${escapeHtml(inr(taxable))}</td>
    <td class="num">${escapeHtml(inr(g.cgst))}</td>
    <td class="num">${escapeHtml(inr(g.sgst))}</td>
    <td class="num" style="font-weight:700;color:#312e81;">${escapeHtml(inr(g.total))}</td>
  </tr>`
  }

  const taxTable = placeInter
    ? `<table class="tax-table">
  <thead>
    <tr><th>Tax Rate</th><th class="num">IGST (Rate)</th><th class="num">IGST (Amount)</th><th class="num">Total</th></tr>
  </thead>
  <tbody>
    <tr><td>${gstRateStr}</td><td class="num">${gstRateStr}</td><td class="num">${escapeHtml(inr(g.igst))}</td><td class="num">${escapeHtml(inr(g.igst))}</td></tr>
  </tbody>
</table>
<div class="tax-words"><strong>Total Tax In Words:</strong> ${escapeHtml(inrAmountWordsPaise(g.igst))}</div>`
    : `<table class="tax-table">
  <thead>
    <tr><th>Tax Rate</th><th class="num">CGST</th><th class="num">SGST</th><th class="num">Total</th></tr>
  </thead>
  <tbody>
    <tr><td>${gstRateStr}</td><td class="num">${escapeHtml(inr(g.cgst))}</td><td class="num">${escapeHtml(inr(g.sgst))}</td><td class="num">${escapeHtml(inr(g.gst))}</td></tr>
  </tbody>
</table>
<div class="tax-words"><strong>Total Tax In Words:</strong> ${escapeHtml(inrAmountWordsPaise(g.gst))}</div>`

  const nCo = normalizeCompanyRecord(co)
  const bankBlock = buildInvoiceBankDetailsHtml(nCo)
  const bankTotGrid = `<div class="bank-tot-grid">
  <div class="card bank-card">${
    bankBlock ||
    `<div class="bank-box" style="color:#94a3b8;font-size:12px;">Add bank details under Company settings to show here.</div>`
  }</div>
  <div class="tot">
    <div class="totline"><span>Amount</span><span>${escapeHtml(inr(taxable))}</span></div>
    ${
      placeInter
        ? `<div class="totline"><span>IGST</span><span>${escapeHtml(inr(g.igst))}</span></div>`
        : `<div class="totline"><span>CGST</span><span>${escapeHtml(inr(g.cgst))}</span></div><div class="totline"><span>SGST</span><span>${escapeHtml(inr(g.sgst))}</span></div>`
    }
    <div class="totline totline-strong"><span>Total (INR)</span><span>${escapeHtml(inr(g.total))}</span></div>
  </div>
</div>`

  const sub = String(subtitle || "").trim()

  return `<div class="inv-wrap">
${buildInvoicePrintHeaderHtml(co, { num, date, dueDate, currencyLabel, placeLabel })}
${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ""}
<div class="grid">
  <div class="card">
    ${buildInvoicePrintBilledByHtml(co)}
  </div>
  <div class="card">
    ${buildInvoicePrintBilledToHtml({ client, gstin, clientAddress, clientPan })}
  </div>
</div>
<table class="inv-table">
  <thead>${thead}</thead>
  <tbody>${row}</tbody>
</table>
${bankTotGrid}
<div class="words"><strong>Amount in words:</strong> ${escapeHtml(inrAmountWords(g.total))}</div>
${taxTable}
${buildInvoicePrintFooterHtml(co)}
${String(notes || "").trim() ? `<div class="notes"><strong>Notes (internal):</strong> ${escapeHtml(String(notes))}</div>` : ""}
</div>`
}

function invoiceBalance(inv) {
  const tot = Number(inv.total) || 0
  const paid = Number(inv.paidAmount) || 0
  return Math.round((tot - paid) * 100) / 100
}

function invoiceBankReceived(inv) {
  const bank = Number(inv?.paidBankTotal)
  if (Number.isFinite(bank)) return Math.round(bank * 100) / 100
  return Math.round((Number(inv?.paidAmount) || 0) * 100) / 100
}

function parseMoneyInput(v) {
  return Math.round((parseFloat(String(v).replace(/,/g, "")) || 0) * 100) / 100
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

function Modal({ open, title, onClose, onSave, saveDisabled, saveLabel, children, wide, footerLeft }) {
  if (!open) return null
  return (
    <div onClick={e => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, background: "rgba(12,74,110,.35)", backdropFilter: "blur(4px)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div
        style={{
          background: SKY.surface,
          border: `1px solid ${SKY.borderHi}`,
          borderRadius: 16,
          width: wide ? "min(960px, 96vw)" : 560,
          maxWidth: "96vw",
          maxHeight: "88vh",
          overflowY: "auto",
          boxShadow: SKY.shadow,
        }}
      >
        <div style={{ padding: "15px 20px", borderBottom: `1px solid ${SKY.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: SKY.text }}>{title}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: SKY.muted, fontSize: 16, padding: "4px 8px" }}>
            ✕
          </button>
        </div>
        <div style={{ padding: 20 }}>{children}</div>
        <div
          style={{
            padding: "12px 20px",
            borderTop: `1px solid ${SKY.border}`,
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            width: "100%",
            boxSizing: "border-box",
          }}
        >
          {footerLeft ? <div style={{ marginRight: "auto", minWidth: 0 }}>{footerLeft}</div> : null}
          <div style={{ display: "flex", gap: 8, marginLeft: footerLeft ? 0 : "auto" }}>
            <button onClick={onClose} style={{ background: "transparent", border: `1px solid ${SKY.borderHi}`, borderRadius: 8, padding: "6px 14px", fontSize: 12, fontWeight: 600, color: SKY.text2, cursor: "pointer" }}>
              Cancel
            </button>
            <button type="button" onClick={onSave} disabled={saveDisabled} style={{ background: saveDisabled ? SKY.border : JM.p, border: "none", borderRadius: 8, padding: "6px 16px", fontSize: 12, fontWeight: 700, color: "#fff", cursor: saveDisabled ? "default" : "pointer", opacity: saveDisabled ? 0.85 : 1 }}>
              {saveLabel || "Save Entry"}
            </button>
          </div>
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

function AddClientAccordion({ title, optional, open, onToggle, children }) {
  return (
    <div style={{ border: `1px solid ${SKY.border}`, borderRadius: 10, marginBottom: 10, overflow: "hidden" }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: "100%",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "12px 14px",
          background: SKY.surface2,
          border: "none",
          cursor: "pointer",
          fontSize: 13,
          fontWeight: 700,
          color: SKY.text,
          fontFamily: "inherit",
          textAlign: "left",
        }}
      >
        <span>
          {title}
          {optional ? <span style={{ color: SKY.muted, fontWeight: 500 }}> (optional)</span> : null}
        </span>
        <span style={{ color: SKY.muted, fontSize: 11 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open ? <div style={{ padding: "12px 14px 16px", borderTop: `1px solid ${SKY.border}` }}>{children}</div> : null}
    </div>
  )
}

/** Draft bank lines from natural language (built-in rules; no external API). */
function extractChatDraftFromUserMessage(msg) {
  if (!msg || typeof msg !== "string") return []
  const rent =
    msg.match(/paid?\s*(?:rs\.?|₹)?\s*([\d,]+)\s*(?:for\s*)?rent/i) ||
    msg.match(/\b([\d,]+)\s*(?:rs\.?|rupees|₹)?\s*(?:kiraya\s+)?rent\s*(?:diya|diya hai|pay|paid|de)?/i) ||
    msg.match(/rent\s*(?:of)?\s*(?:rs\.?|₹)?\s*([\d,]+)/i) ||
    msg.match(/rent\s+paid\s*(?:rs\.?|rupees|₹)?\s*([\d,]+)/i)
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
    desc = rm ? "Rent payment" : pm ? "Payment for " + pm[2].trim() : "Revenue from " + rcm[2].trim()
    type = rcm ? "CR" : "DR"
    cat = rm ? "Rent Expense" : rcm ? "Misc Income" : "Misc Expense"
  }
  if (!(amt > 0 && desc && type && cat)) return []
  return [{ amt, desc, type, cat, dateIso: null }]
}

/** Parse ₹ / amount from pasted bank text (e.g. +₹31,860.00). */
function parseAmountFromBankPaste(msg) {
  if (!msg || typeof msg !== "string") return null
  let m = msg.match(/\+?\s*₹\s*([\d,]+(?:\.\d{1,2})?)/)
  if (m) return Math.round(parseFloat(m[1].replace(/,/g, "")) * 100) / 100
  m = msg.match(/\b([\d,]+(?:\.\d{1,2})?)\s*(?:CR|DR)\b/i)
  if (m) return Math.round(parseFloat(m[1].replace(/,/g, "")) * 100) / 100
  return null
}

/** First dd/mm/yyyy (or dd-mm-yyyy) in message. */
function parseDdMmYyyyFromPaste(msg) {
  const m = String(msg || "").match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/)
  if (!m) return null
  let d = parseInt(m[1], 10)
  let mo = parseInt(m[2], 10)
  let y = parseInt(m[3], 10)
  if (y < 100) y += 2000
  return `${String(d).padStart(2, "0")}/${String(mo).padStart(2, "0")}/${y}`
}

/**
 * Map free-text ("B2B Revenu", "rent", "Naukri") to a ledger category from CATS.
 */
function resolveChatRecategorizeTarget(msg) {
  const tail = msg.match(/(?:\b(?:as|to|in|under|into)\s+)(.+?)(?:\.|$)/i)
  const fragment = (tail ? tail[1] : msg).trim()
  const f = fragment.toLowerCase().replace(/[.,;]+$/g, "").trim()
  if (!f) return null
  if (
    /b2b\s*revenu|b2b\s*revenue|revenue\s*b2b|revenu\s*b2b|b2b\s*serv/i.test(f) ||
    (/b2b/.test(f) && /revenu|revenue|serv/.test(f))
  )
    return "Revenue - B2B Services"
  if (/saas|subscription|recurr/i.test(f)) return "Revenue - SaaS / Subscriptions"
  if (/marketplace/i.test(f)) return "Revenue - Marketplace"
  if (/professional\s*fee/i.test(f)) return "Revenue - Professional Fees"
  if (/rent|lease|kiraya/i.test(f)) return "Rent Expense"
  if (/salary|payroll|wages/i.test(f)) return "Salary"
  if (/naukri|linkedin|indeed|job\s*portal|recruitment|hiring/i.test(f)) return "Recruitment - Job Portals"
  if (/vendor.*it|it\s*solution|jana\s*sfb/i.test(f)) return "Vendor - IT Solutions"
  if (/vendor|supplier/i.test(f) && !/it\s*solution/.test(f)) return "Vendor - Other"
  if (/bank\s*charg|sms\s*chg/i.test(f)) return "Bank Charges"
  if (/director/i.test(f)) return "Director Payment"
  if (/capital|infusion/i.test(f)) return "Capital Infusion - Director"
  if (/gst|cgst|sgst|igst/i.test(f) && /pay|deposit/i.test(f)) return "GST Payment (Output Tax)"
  return null
}

function hasChatRecategorizeIntent(msg) {
  const low = String(msg || "").toLowerCase()
  if (/\b(recategorize|reclassify|re-categor|change\s+categor)/i.test(msg)) return true
  if (/\bmark\s+this\b/i.test(msg)) return true
  // Do not match bare "mark paid" / "mark …" — that was hijacking GST "mark paid" messages.
  if (/\b(mark|set|move|book|categorize)\s+(?:(?:this|the|that)\b|(?:transaction|line|entry|txn)\b)/i.test(msg)) return true
  if (/\b(mark|set|move|book)\b/i.test(msg) && /\b(as|to|in|under|into)\b/i.test(low)) return true
  if (/\b(neft|imps|upi|rtgs)\b/i.test(msg) && /\b(misc\s+income|misc\s+expense)\b/i.test(low) && /\b(b2b|revenue|revenu|reclassify|mark|as|to|in)\b/i.test(low))
    return true
  return false
}

function extractRecategorizeNameAnchor(msg, target) {
  const raw = String(msg || "")
  if (!raw.trim()) return ""

  const quoted = raw.match(/["'`]{1}([^"'`]{2,120})["'`]{1}/)
  if (quoted) return quoted[1].trim()

  const m = raw.match(/\b(?:name|part(?:icular)?s?|narration|description)\s*(?:is|:)?\s*([^\n,.;]{2,140})/i)
  if (m) {
    let s = String(m[1] || "").trim()
    if (target) s = s.replace(new RegExp(`\\b${String(target).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"), "").trim()
    return s
  }

  const pre = raw.split(/\b(?:as|to|in|under|into)\b/i)[0] || ""
  let s = pre
    .replace(/\b(recategorize|reclassify|re-categor|change|set|move|mark|book|categorize|category|txn|transaction|line|entry|this|that|the)\b/gi, " ")
    .replace(/\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/g, " ")
    .replace(/[₹,]/g, " ")
    .replace(/\b\d+(?:\.\d+)?\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (target) {
    s = s
      .replace(new RegExp(`\\b${String(target).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"), "")
      .replace(/\s+/g, " ")
      .trim()
  }
  return s
}

function tokenizeAnchor(anchor) {
  return String(anchor || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map(s => s.trim())
    .filter(s => s.length >= 3)
}

function extractTxnLookupAnchor(msg) {
  const text = String(msg || "").trim()
  if (!text) return ""
  const q = text.match(/["'`]{1}([^"'`]{2,120})["'`]{1}/)
  if (q) return q[1].trim()
  const p1 = text.match(/\b(?:list|show|find|search)\s+(?:of\s+)?(.+?)\s*(?:txn|transaction|transactions)\b/i)
  if (p1) return String(p1[1] || "").trim()
  const p2 = text.match(/\b(?:txn|transaction|transactions)\s+(?:of|for|with|named)\s+(.+)$/i)
  if (p2) return String(p2[1] || "").trim()
  const p3 = text.match(/\b(?:name|part(?:icular)?s?|narration)\s*(?:is|:)?\s*([^\n,.;]{2,140})/i)
  if (p3) return String(p3[1] || "").trim()
  return ""
}

function hasTxnLookupIntent(msg) {
  const m = String(msg || "")
  return /\b(list|show|find|search|which|where)\b/i.test(m) && /\b(txn|transaction|transactions)\b/i.test(m)
}

function tryTxnLookupByName(msg, txns) {
  if (!hasTxnLookupIntent(msg)) return null
  const anchor = extractTxnLookupAnchor(msg)
  const terms = tokenizeAnchor(anchor)
  if (!terms.length) return { type: "need_anchor" }
  const pool = (Array.isArray(txns) ? txns : []).filter(t => !t.void)
  const rows = pool.filter(t => {
    const p = String(t.particulars || "").toLowerCase()
    return terms.every(w => p.includes(w))
  })
  if (!rows.length) return { type: "no_match", anchor }
  const sorted = [...rows].sort((a, b) => parseDdMmYyyy(b.date) - parseDdMmYyyy(a.date) || b.id - a.id)
  return { type: "ready", anchor, rows: sorted.slice(0, 8), total: rows.length }
}

/**
 * If user asks to recategorize a line, match by date + amount and/or particulars text.
 * @returns {null | { type: string, t?: object, target?: string, n?: number, amount?: any, date?: any }}
 */
function tryChatRecategorize(msg, txns) {
  if (!msg?.trim() || !Array.isArray(txns) || !txns.length) return null
  if (!hasChatRecategorizeIntent(msg)) return null
  const target = resolveChatRecategorizeTarget(msg)
  if (!target) return { type: "no_target" }
  if (!CATS.includes(target)) return { type: "no_target" }

  const amt = parseAmountFromBankPaste(msg)
  const date = parseDdMmYyyyFromPaste(msg)
  const anchor = extractRecategorizeNameAnchor(msg, target)
  const terms = tokenizeAnchor(anchor)

  let pool = txns.filter(t => !t.void)
  if (date) pool = pool.filter(t => t.date === date)
  if (amt != null) pool = pool.filter(t => Math.round((Number(t.amount) || 0) * 100) === Math.round(amt * 100))
  if (terms.length) {
    pool = pool.filter(t => {
      const p = String(t.particulars || "").toLowerCase()
      return terms.every(w => p.includes(w))
    })
  }
  if (amt == null && !date && !terms.length) return { type: "no_anchor" }

  if (pool.length === 0) return { type: "no_match", amount: amt, date, target }
  if (pool.length > 1) return { type: "ambiguous", n: pool.length, amount: amt, date, target }
  const t = pool[0]
  if (t.category === target) return { type: "already", t, target }
  return { type: "ready", t, target }
}

/**
 * Before posting a new chat draft, check if an existing txn already matches
 * the same amount (+ optional date) and offer category change instead.
 */
function tryFindExistingTxnForDraft(msg, draftEntries, txns) {
  if (!Array.isArray(draftEntries) || !draftEntries.length || !Array.isArray(txns) || !txns.length) return null
  const d = draftEntries[0]
  const amt = Math.round((Number(d?.amt) || 0) * 100)
  if (!amt) return null
  const date = parseDdMmYyyyFromPaste(msg || "")
  const active = txns.filter(t => !t.void)
  let pool = active.filter(t => Math.round((Number(t.amount) || 0) * 100) === amt)
  if (date) pool = pool.filter(t => t.date === date)
  if (pool.length === 0) return null
  if (pool.length > 1) return { type: "ambiguous", n: pool.length, amount: amt / 100, date }
  const t = pool[0]
  const target = String(d?.cat || "").trim()
  if (!target || !CATS.includes(target)) return { type: "exists", t }
  if (t.category === target) return { type: "already", t, target }
  return { type: "ready", t, target }
}

/** Deduped short strings saved per company for the embedded assistant (browser storage). */
function normalizeAssistantMemory(arr) {
  if (!Array.isArray(arr)) return []
  const seen = new Set()
  const out = []
  for (const raw of arr) {
    const s = String(raw || "")
      .trim()
      .slice(0, 400)
    if (!s) continue
    const k = s.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(s)
    if (out.length >= 40) break
  }
  return out
}

/**
 * If user is teaching a fact (party = client, etc.), return text to store; else null.
 * Chat is rule-based (no LLM) — without this, messages fall through to generic ledger one-liners.
 */
function tryExtractAssistantMemoryNote(msg) {
  const m = String(msg || "").trim()
  if (!m || m.length > 500) return null
  const colon = m.match(/^(?:remember|note|save|store|memo|याद)\s*[:：]\s*(.+)$/i)
  if (colon) return colon[1].trim().slice(0, 400)
  const readIt = /^read\s+it\s+(.+)/i.exec(m)
  if (readIt) return readIt[1].trim().slice(0, 400)
  if (/\bis\s+(?:my|our)\s+(?:client|customer|vendor|supplier|debtor|creditor)\b/i.test(m)) return m.slice(0, 400)
  return null
}

function formatAssistantMemoryBlock(lines) {
  const a = normalizeAssistantMemory(lines)
  if (!a.length) return ""
  const tail = a.slice(-8)
  return `\n\n**Saved notes (this company):**\n${tail.map(t => `• ${t}`).join("\n")}`
}

/**
 * Chat: "EPFO … ko Employer PF / ESI Expense … map" → automation categorize rule (confirm in UI).
 */
function tryParseCategorizeAutomationFromMessage(msg, allowedCategories) {
  const text = String(msg || "").trim()
  if (!text || text.length > 900) return null
  const lower = text.toLowerCase()
  const wantsRule =
    /\b(map|map\s*kar|mapping|auto[\s-]?categor|auto[\s-]?sort|categorize|reclassify|rule)\b/i.test(text) ||
    /\bko\s+.+\s+(?:isme\s+)?map\b/i.test(text) ||
    /\bmap\s*kar[oо]?\b/i.test(text)
  if (!wantsRule) return null

  const sorted = [...allowedCategories].sort((a, b) => b.length - a.length)
  let category = null
  for (const c of sorted) {
    if (lower.includes(c.toLowerCase())) {
      category = c
      break
    }
  }
  if (!category) {
    if (/employer\s*pf|pf\s*\/\s*esi|esi\s*expense|\bpf\b.*\besi\b/i.test(lower)) category = "Employer PF / ESI Expense"
  }
  if (!category || !allowedCategories.includes(category)) return null

  let match = null
  const kw = text.match(
    /\b(epfo|epf\s*\+?\s*esi|epf|esic|esi|pf|provident\s*fund|employee\s*state\s*insurance)\b/i
  )
  if (kw) {
    match = kw[1].toLowerCase().replace(/\s+/g, " ").trim()
    if (match === "provident fund") match = "pf"
  }
  if (!match) {
    const beforeKo = text.split(/\s+ko\s+/i)[0] || ""
    const k2 = beforeKo.match(/\b([a-z0-9]{2,})\b/i)
    if (k2) match = k2[1].toLowerCase()
  }
  if (!match || match.length < 2) return null

  return {
    match: match.slice(0, 120),
    category,
    label: `${match} → ${category}`.slice(0, 120),
  }
}

/** Rule-based answers from Indian accounting / GST / TDS + live snap (no API keys). */
function localAccountingAssistantReply(
  msg,
  welcomeName,
  snap,
  { draftEntries = [], draftSummary = "", assistantMemory = [] } = {}
) {
  const w = String(welcomeName || "your company").replace(/</g, "")
  const s = snap || {}
  const low = msg.trim().toLowerCase()
  const bal = inr0(s.balance ?? 0)
  const topRev = String(s.topRevName || "—").slice(0, 80)
  const topRevAmt = inr0(s.topRevAmt ?? 0)
  const gstEst = inr0(s.gstEst ?? 0)
  const topDrLines = Array.isArray(s.topDrCats)
    ? s.topDrCats
        .slice(0, 3)
        .map(([n, a]) => `**${String(n).slice(0, 48)}** · ₹${inr0(a)}`)
        .join("\n")
    : ""

  const jeRent = msg.match(/journal\s+entry:?\s*rent\s+paid\s*(?:rs\.?|rupees|₹)?\s*([\d,]+)/i)
  if (jeRent && draftEntries.length && draftSummary) {
    const a = inr0(parseFloat(jeRent[1].replace(/,/g, "")))
    return `**Double-entry (rent paid):** Dr **Rent Expense** **₹${a}**, Cr **Bank** **₹${a}** — **ΣDr = ΣCr**.\n\n${draftSummary}\n\nI've opened a **review card** below — edit if needed, then confirm.`
  }

  if (draftEntries.length && draftSummary) {
    return `${draftSummary}\n\nI've opened a **review card** below — edit if needed, then confirm. Nothing is saved until you confirm.`
  }

  const chips = {
    "what is my gst liability?": `**Output GST (from your books, estimate):** **₹${gstEst}**. This is a ledger-based hint, not a filed return.\n\n**Typical IT services:** SAC **998314**, **18%** (CGST+SGST intra-state). **GSTR-1** often **11th**, **GSTR-3B** payment **20th** (verify for your period on the GST portal).`,
    "explain my b2b revenue": `**Top revenue category** in your ledger: **${topRev}** · **₹${topRevAmt}**.\n\nTreat B2B sales with GST invoices as **Revenue** (credit) with output tax tracked per your invoice workflow; intra-state IT services often use **18%** on SAC **998314**.`,
    "tds on ₹80,000 salary": `**TDS Sec 192 (salary)** uses **slab rates** (employer calculates). On a **₹80,000** monthly payout, tax depends on annual projections, regime, exemptions, and proof — I can't give an exact TDS without full salary structure.\n\n**Pointer:** new-regime slabs are commonly quoted as **0–3L 0%**, **3–7L 5%**, **7–10L 10%**, **10–12L 15%**, **12–15L 20%**, **>15L 30%** (verify current law/notifications).`,
    "gst on ₹1,50,000 invoice": `At **18%** GST, tax on **₹1,50,000** taxable value ≈ **₹27,000** (total bill ≈ **₹1,77,000** if tax is on top of base). Use **CGST+SGST** intra-state or **IGST** inter-state per place of supply.`,
    "top 3 expenses?": topDrLines
      ? `**Top debit categories** (from your live ledger):\n${topDrLines}`
      : `Add more **payment** lines to your ledger to rank expenses. **Salary (DR)** so far: **₹${inr0(s.salaryDr ?? 0)}**.`,
    "journal entry: rent paid ₹20,000": `**Double-entry (rent paid):** Dr **Rent Expense** **₹20,000**, Cr **Bank** **₹20,000** — **ΣDr = ΣCr**.\n\nA **review card** should appear below for this draft; confirm to post.`,
    "list agent skills & protocol": getAgentSkillsOverviewMarkdown(s),
    "what can you do": `${getAgentSkillsOverviewMarkdown(s)}\n\nTip: ask **bank vs invoice matching**, **TDS when bank < invoice**, or **JSON output schema**.`,
  }
  if (chips[low]) return chips[low]

  const agentReply = matchEnterpriseAgentQuery(msg, s)
  if (agentReply) return agentReply

  if (/\b(naukri|linkedin|indeed|shine|monster|foundit|apna|workindia|jobhai|job\s*portal|recruitment)\b/i.test(msg)) {
    return `Bank debits to **job / hiring portals** (Naukri, LinkedIn, Indeed, etc.) belong under **Recruitment - Job Portals**, not **Director Payment** — unless the narration is clearly **director remuneration**.`
  }

  if (/\b(gstr-?1|gstr-?3b|gst\s*return|gst\s*filing)\b/i.test(msg)) {
    return `**GST filing cadence (typical):** **GSTR-1** by **11th** of the next month; **GSTR-3B** payment by **20th** (confirm on **https://www.gst.gov.in** for your period). Output GST estimate from your books: **₹${gstEst}**.`
  }

  if (/\btds\b/i.test(msg) && /\b(194|192|section)\b/i.test(msg)) {
    return `**Common TDS rates (verify notifications):** **192** salary (slab); **194J** professional **10%**; **194C** contractor **1%** (individual) / **2%** (others); **194I** rent **10%**. Deposit via **Challan 281** by due dates.`
  }

  if (/\btds\b/i.test(msg)) {
    return `**TDS:** employer deducts under **Sec 192**; payers deduct under **194J** (fees), **194C** (contracts), **194I** (rent), etc. Rates and thresholds change — confirm on **TRACES** / current CBDT circulars.`
  }

  if (/\bgst\b|igst|cgst|sgst|sac\s*998314/i.test(msg)) {
    return `**GST (India):** many IT / software services use SAC **998314** at **18%** (**CGST+SGST** same state). Your **output GST (est.)** from the ledger: **₹${gstEst}**. **GSTR-1** / **3B** dates depend on your filing period — check the GST portal.`
  }

  if (/\b(double[- ]?entry|journal|golden rule|debit.*credit)\b/i.test(msg)) {
    return `**Double-entry:** every transaction has **≥2 legs** with **ΣDr = ΣCr**. **Payment:** Dr expense (or asset), Cr **Bank**. **Receipt:** Dr **Bank**, Cr income (or liability reduction). **Golden rules:** Real — debit what comes in; Personal — debit receiver, credit giver; Nominal — debit expense/loss, credit income/gain.`
  }

  if (/\b(bank balance|ledger balance|kitna.*balance|how much.*(money|bank))\b/i.test(low) || (/\bbalance\b/i.test(msg) && /\b(bank|ledger)\b/i.test(msg))) {
    return `From your **live ledger** in this browser, approximate **bank balance** is **₹${bal}** (**${s.count ?? 0}** transactions). Top revenue line: **${topRev}** · **₹${topRevAmt}**.${formatAssistantMemoryBlock(assistantMemory)}`
  }

  const mem = formatAssistantMemoryBlock(assistantMemory)
  return `I need a bit more detail to act on this.\n\nTry one of these:\n- **list txn of <name>**\n- **change txn #<id> to <category>**\n- **<date> <amount> ko <category> karo**\n\n${mem ? `Also, saved notes for this company are available.${mem}` : ""}`
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
  const chip = (primary, onClick, label, disabled) => (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        border: primary ? "none" : "1px solid #bae6fd",
        borderRadius: 999,
        padding: "8px 16px",
        fontSize: 11,
        fontWeight: 700,
        cursor: disabled ? "default" : "pointer",
        fontFamily: "inherit",
        background: primary ? (disabled ? "#bae6fd" : "#10b981") : "#ffffff",
        color: primary ? "#fff" : "#64748b",
        boxShadow: primary && !disabled ? "0 2px 8px rgba(16,185,129,.35)" : "none",
      }}
    >
      {label}
    </button>
  )
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
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
        {chip(
          true,
          () =>
            onAddBatch(
              lines.map(L => ({
                particulars: L.particulars.trim(),
                amount: L.amount,
                drCr: L.drCr,
                category: L.category,
                date: L.date,
              }))
            ),
          acctRole === "Viewer" ? "View-only" : lines.length > 1 ? "✓ Confirm · सभी पोस्ट" : "✓ Confirm · लेजर में डालें",
          acctRole === "Viewer"
        )}
        {chip(false, onDismiss, "✕ Cancel", false)}
      </div>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#0c4a6e", marginBottom: 8 }}>Review before adding</div>
      <div style={{ fontSize: 10, color: "#64748b", marginBottom: 10 }}>
        ज़रूरत हो तो ऊपर से पहले एडिट करें, फिर <strong>Confirm</strong>।
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
      <div style={{ fontSize: 11, fontWeight: 600, color: "#0c4a6e", marginTop: 4 }}>
        Total ₹{inr(sum)}
      </div>
    </div>
  )
}

function ChatRecategorizeCard({ acctRole, txnId, fromCat, toCat, particulars, onApply, onDismiss }) {
  const chip = (primary, onClick, label, disabled) => (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        border: primary ? "none" : "1px solid #bae6fd",
        borderRadius: 999,
        padding: "8px 16px",
        fontSize: 11,
        fontWeight: 700,
        cursor: disabled ? "default" : "pointer",
        fontFamily: "inherit",
        background: primary ? (disabled ? "#bae6fd" : "#10b981") : "#ffffff",
        color: primary ? "#fff" : "#64748b",
        boxShadow: primary && !disabled ? "0 2px 8px rgba(16,185,129,.35)" : "none",
      }}
    >
      {label}
    </button>
  )
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
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {chip(true, onApply, acctRole === "Viewer" ? "View-only" : "✓ Confirm · कैटेगरी बदलें", acctRole === "Viewer")}
        {chip(false, onDismiss, "✕ Cancel", false)}
      </div>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#0c4a6e", marginBottom: 6 }}>Recategorise (Misc → correct ledger)</div>
      <div style={{ fontSize: 10, color: "#64748b", marginBottom: 10, lineHeight: 1.5 }}>
        Txn <strong>#{txnId}</strong> · <strong>{fromCat}</strong> → <strong style={{ color: JM.p }}>{toCat}</strong>
      </div>
      <div style={{ fontSize: 11, color: "#0369a1", marginBottom: 0, lineHeight: 1.45, wordBreak: "break-word" }}>
        {String(particulars || "").slice(0, 220)}
        {String(particulars || "").length > 220 ? "…" : ""}
      </div>
    </div>
  )
}

function ChatAutomationRuleConfirmCard({ draft, onSaveOnly, onSaveApply, onDismiss, disabled }) {
  const d = draft || {}
  const chip = (primary, onClick, label) => (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        border: primary ? "none" : "1px solid #bae6fd",
        borderRadius: 999,
        padding: "8px 14px",
        fontSize: 11,
        fontWeight: 700,
        cursor: disabled ? "default" : "pointer",
        fontFamily: "inherit",
        opacity: disabled ? 0.45 : 1,
        background: primary ? "#10b981" : "#ffffff",
        color: primary ? "#fff" : "#64748b",
        boxShadow: primary && !disabled ? "0 2px 8px rgba(16,185,129,.35)" : "none",
      }}
    >
      {label}
    </button>
  )
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
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {chip(false, onSaveOnly, "✓ Save rule")}
        {chip(true, onSaveApply, "✓ Save & apply to ledger")}
        {chip(false, onDismiss, "✕ Cancel")}
      </div>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#0c4a6e", marginBottom: 6 }}>Auto-categorise rule</div>
      <div style={{ fontSize: 10, color: "#64748b", marginBottom: 8, lineHeight: 1.45 }}>
        जहाँ narration में <strong>{String(d.match || "")}</strong> हो → <strong style={{ color: JM.p }}>{String(d.category || "")}</strong>
      </div>
    </div>
  )
}

function ChatMemoryConfirmCard({ note, onSave, onDismiss }) {
  const safe = String(note || "").replace(/[<>]/g, "")
  const chip = (primary, onClick, label) => (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: primary ? "none" : "1px solid #bae6fd",
        borderRadius: 999,
        padding: "8px 16px",
        fontSize: 11,
        fontWeight: 700,
        cursor: "pointer",
        fontFamily: "inherit",
        background: primary ? "#10b981" : "#ffffff",
        color: primary ? "#fff" : "#64748b",
        boxShadow: primary ? "0 2px 8px rgba(16,185,129,.35)" : "none",
      }}
    >
      {label}
    </button>
  )
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
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {chip(true, onSave, "✓ Save")}
        {chip(false, onDismiss, "✕ Cancel")}
      </div>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#0c4a6e", marginBottom: 6 }}>Save note (this company)</div>
      <div style={{ fontSize: 11, color: "#0369a1", lineHeight: 1.45, wordBreak: "break-word" }}>{safe}</div>
    </div>
  )
}

function BulkSalaryPastePanel({ onAddBatch, acctRole, cats, onBulkSalaryPosted }) {
  const [raw, setRaw] = useState("")
  const [defaultCat, setDefaultCat] = useState("Salary")
  const [defaultDate, setDefaultDate] = useState(() => todayISO())
  const [preview, setPreview] = useState(null)
  const [err, setErr] = useState("")

  const runPreview = () => {
    setErr("")
    const r = parseBulkSalaryPaste(raw, { defaultDateIso: defaultDate, defaultCategory: defaultCat })
    if (!r.ok) {
      setPreview(null)
      setErr(r.error || "Parse failed")
      return
    }
    setPreview(r)
  }

  const postAll = () => {
    if (!preview?.ok || !preview.rows?.length) return
    const entries = bulkSalaryRowsToConfirmEntries(preview.rows)
    const rows = entries.map(e => ({
      particulars: e.desc,
      amount: String(e.amt),
      drCr: e.type === "CR" ? "CR" : "DR",
      category: e.cat,
      date: e.dateIso,
    }))
    const ok = onAddBatch(rows)
    if (ok) {
      if (typeof onBulkSalaryPosted === "function") onBulkSalaryPosted(rows.length)
      setRaw("")
      setPreview(null)
      setErr("")
    }
  }

  const sum = preview?.ok ? preview.rows.reduce((s, r) => s + r.amount, 0) : 0

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: 14, maxWidth: 800 }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: "#0c4a6e", marginBottom: 8 }}>Bulk salary &amp; payroll lines</div>
      <div style={{ fontSize: 11, color: SKY.muted, lineHeight: 1.55, marginBottom: 12 }}>
        Paste a table copied from Excel/Sheets (tabs between columns). One row per employee. Columns:{" "}
        <strong style={{ color: SKY.text2 }}>Name</strong>, <strong style={{ color: SKY.text2 }}>Amount</strong>,{" "}
        <strong style={{ color: SKY.text2 }}>Type</strong> (e.g. Salary), <strong style={{ color: SKY.text2 }}>Date</strong> (e.g.{" "}
        <code style={{ fontSize: 10 }}>2 April 2026</code> or <code style={{ fontSize: 10 }}>2026-04-02</code>). Header row is optional.
        Narration posted as <strong style={{ color: SKY.text2 }}>Salary — Name</strong> (bank debit). You can also paste the same table in{" "}
        <strong style={{ color: SKY.text2 }}>Chat</strong> — a review card will open if 2+ rows parse.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
        <F label="Default date (if a row has no date)">
          <input type="date" value={defaultDate} onChange={e => setDefaultDate(e.target.value)} style={IS} disabled={acctRole === "Viewer"} />
        </F>
        <F label="Default type when column missing">
          <select value={defaultCat} onChange={e => setDefaultCat(e.target.value)} style={IS} disabled={acctRole === "Viewer"}>
            {(cats || []).map(c => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </F>
      </div>
      <F label="Paste rows">
        <textarea
          value={raw}
          onChange={e => {
            setRaw(e.target.value)
            setPreview(null)
            setErr("")
          }}
          placeholder={"Neetesh\t20,771\tSalary\t2 April 2026\nVishal\t11,609\tSalary\t2 April 2026"}
          rows={12}
          style={{ ...IS, width: "100%", boxSizing: "border-box", fontFamily: "ui-monospace, monospace", fontSize: 11 }}
          disabled={acctRole === "Viewer"}
        />
      </F>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10, marginBottom: 12 }}>
        <button
          type="button"
          disabled={acctRole === "Viewer"}
          onClick={runPreview}
          style={{
            background: JM.p,
            border: "none",
            borderRadius: 9,
            padding: "8px 16px",
            fontSize: 12,
            fontWeight: 700,
            color: "#fff",
            cursor: acctRole === "Viewer" ? "default" : "pointer",
            opacity: acctRole === "Viewer" ? 0.5 : 1,
            fontFamily: "inherit",
          }}
        >
          Preview
        </button>
        <button
          type="button"
          disabled={acctRole === "Viewer" || !preview?.ok}
          onClick={postAll}
          style={{
            background: preview?.ok ? "#10b981" : "#bae6fd",
            border: "none",
            borderRadius: 9,
            padding: "8px 16px",
            fontSize: 12,
            fontWeight: 700,
            color: "#fff",
            cursor: acctRole === "Viewer" || !preview?.ok ? "default" : "pointer",
            opacity: acctRole === "Viewer" || !preview?.ok ? 0.55 : 1,
            fontFamily: "inherit",
          }}
        >
          Post all to ledger
        </button>
      </div>
      {err ? (
        <div style={{ fontSize: 11, color: "#f43f5e", marginBottom: 10 }}>{err}</div>
      ) : null}
      {preview?.ok && preview.warnings?.length ? (
        <div style={{ fontSize: 10, color: "#f59e0b", marginBottom: 8, lineHeight: 1.45 }}>{preview.warnings.join(" ")}</div>
      ) : null}
      {preview?.ok ? (
        <div style={{ border: `1px solid ${SKY.border}`, borderRadius: 10, overflow: "hidden" }}>
          <div style={{ fontSize: 10, fontWeight: 800, padding: "8px 10px", background: SKY.surface2, color: SKY.text2 }}>
            {preview.rows.length} line(s) · Total ₹{inr(sum)}
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr style={{ background: "#f8fafc" }}>
                <th style={{ textAlign: "left", padding: 8 }}>Employee</th>
                <th style={{ textAlign: "right", padding: 8 }}>Amount</th>
                <th style={{ textAlign: "left", padding: 8 }}>Category</th>
                <th style={{ textAlign: "left", padding: 8 }}>Date</th>
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((r, i) => (
                <tr key={i} style={{ borderTop: `1px solid ${SKY.rowLine}` }}>
                  <td style={{ padding: 8 }}>{r.name}</td>
                  <td style={{ padding: 8, textAlign: "right", fontFamily: "monospace" }}>₹{inr(r.amount)}</td>
                  <td style={{ padding: 8 }}>{r.category}</td>
                  <td style={{ padding: 8, fontFamily: "monospace" }}>{r.dateIso}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}

function Chat({
  onAddBatch,
  acctRole,
  snap,
  welcomeName,
  automationSkills,
  setAutomationSkills,
  onRunAutomation,
  onPostTemplate,
  cats,
  onBankStatementFile,
  onOpenInvoiceModal,
  ledgerTxns,
  onRecategorizeTxn,
  assistantMemory,
  onAssistantMemoryAdd,
  onRemoveAssistantNote,
  onAutomationRuleConfirm,
  onBulkSalaryPosted,
}) {
  const s = snap || {}
  const w = welcomeName || "your company"
  const [aiTab, setAiTab] = useState("chat")
  const [msgs, setMsgs] = useState([
    {
      role: "ai",
      text: `**${w}** — बोलो या फाइल अपलोड करो → **लेजर में एंट्री**। बैंक CSV/XLSX यहीं इम्पोर्ट होता है।`,
    },
  ])
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const ref = useRef(null)
  const hist = useRef([])
  const bankFileRef = useRef(null)

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [msgs])

  const chips = ["rent 20k diya", "salary 50k mila", "List Misc transactions", "GST kitna?", "remember: …"]

  const send = msg => {
    if (!msg.trim() || busy) return
    setInput("")
    setMsgs(p => [...p, { role: "user", text: msg }])
    hist.current.push({ role: "user", content: msg })
    setBusy(true)
    setMsgs(p => [...p, { role: "ai", text: "...", loading: true }])
    try {
      const memNote = tryExtractAssistantMemoryNote(msg)
      if (memNote && typeof onAssistantMemoryAdd === "function") {
        const cur = normalizeAssistantMemory(assistantMemory || [])
        if (cur.some(s => s.toLowerCase() === memNote.toLowerCase())) {
          const safe = memNote.replace(/[<>]/g, "")
          const text = `पहले से सेव है:\n\n**${safe}**`
          hist.current.push({ role: "assistant", content: text })
          setMsgs(p => p.slice(0, -1).concat([{ role: "ai", text }]))
          return
        }
        const memoryId = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
        hist.current.push({ role: "assistant", content: memNote })
        setMsgs(p =>
          p.slice(0, -1).concat([{ role: "memory_confirm", memoryId, noteText: memNote }])
        )
        return
      }

      const ruleDraft = tryParseCategorizeAutomationFromMessage(msg, CATS)
      if (ruleDraft && typeof onAutomationRuleConfirm === "function") {
        if (acctRole === "Viewer") {
          const text = "View-only — rules add नहीं हो सकते।"
          hist.current.push({ role: "assistant", content: text })
          setMsgs(p => p.slice(0, -1).concat([{ role: "ai", text }]))
          return
        }
        const ruleId = `rule-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
        hist.current.push({ role: "assistant", content: ruleDraft.label })
        setMsgs(p =>
          p.slice(0, -1).concat([{ role: "automation_rule_confirm", ruleId, draft: ruleDraft }])
        )
        return
      }

      const gstPay = tryGstPaymentJournalFromChat(msg, { gstEstFallback: s?.gstEst })
      if (gstPay) {
        if (acctRole === "Viewer") {
          const text = "View-only — posting blocked."
          hist.current.push({ role: "assistant", content: text })
          setMsgs(p => p.slice(0, -1).concat([{ role: "ai", text }]))
          return
        }
        const text = `**₹${inr0(gstPay.draft.amt)}** · GST payment (bank) · ${gstPay.draft.cat}\n\nनीचे **✓ Add to books** — confirm करके लेजर में डालें।`
        hist.current.push({ role: "assistant", content: text })
        setMsgs(p => p.slice(0, -1).concat([{ role: "ai", text }]))
        window.setTimeout(
          () =>
            setMsgs(p => [
              ...p,
              {
                role: "confirm",
                confirmId: `gst-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                entries: [gstPay.draft],
              },
            ]),
          400
        )
        return
      }

      const bulkSal = parseBulkSalaryPaste(msg, { defaultDateIso: todayISO(), defaultCategory: "Salary" })
      if (bulkSal.ok && bulkSal.rows.length >= 2) {
        if (acctRole === "Viewer") {
          const text = "View-only — posting blocked."
          hist.current.push({ role: "assistant", content: text })
          setMsgs(p => p.slice(0, -1).concat([{ role: "ai", text }]))
          return
        }
        const warn = bulkSal.warnings?.length ? `\n\n⚠ ${bulkSal.warnings.slice(0, 8).join(" ")}` : ""
        const text = `**${bulkSal.rows.length} salary lines** parsed.${warn}\n\nReview & edit below, then **Confirm · सभी पोस्ट**.`
        hist.current.push({ role: "assistant", content: text })
        setMsgs(p => p.slice(0, -1).concat([{ role: "ai", text }]))
        const entries = bulkSalaryRowsToConfirmEntries(bulkSal.rows)
        window.setTimeout(
          () =>
            setMsgs(p => [
              ...p,
              {
                role: "confirm",
                confirmId: `salary-bulk-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                entries,
              },
            ]),
          400
        )
        return
      }

      const recat = tryChatRecategorize(msg, ledgerTxns || [])
      if (recat?.type === "ready") {
        const t = recat.t
        const target = recat.target
        if (acctRole === "Viewer") {
          const text = "View-only — category change blocked."
          hist.current.push({ role: "assistant", content: text })
          setMsgs(p => p.slice(0, -1).concat([{ role: "ai", text }]))
          return
        }
        const text = `**#${t.id}** · ${t.date} · ₹${inr0(t.amount)} → **${target}**\n\nनीचे **✓ Apply** दबाएँ — तभी लेजर अपडेट।`
        hist.current.push({ role: "assistant", content: text })
        setMsgs(p => p.slice(0, -1).concat([{ role: "ai", text }]))
        const recatId = `rc-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
        window.setTimeout(
          () =>
            setMsgs(p => [
              ...p,
              {
                role: "recat_confirm",
                recatId,
                txnId: t.id,
                fromCat: t.category,
                toCat: target,
                particulars: t.particulars,
              },
            ]),
          400
        )
        return
      }

      if (recat == null) {
        const emb = tryEmbeddedAgentHelp(msg, { txns: ledgerTxns || [] })
        if (emb) {
          hist.current.push({ role: "assistant", content: emb })
          setMsgs(p => p.slice(0, -1).concat([{ role: "ai", text: emb }]))
          return
        }
        const jr = tryNaturalLanguageJournal(msg)
        if (jr) {
          if (acctRole === "Viewer") {
            const text = "View-only — posting blocked."
            hist.current.push({ role: "assistant", content: text })
            setMsgs(p => p.slice(0, -1).concat([{ role: "ai", text }]))
            return
          }
          const text = `**₹${inr0(jr.draft.amt)}** · ${jr.draft.cat} · ${jr.draft.type === "CR" ? "Receipt" : "Payment"}\n\nनीचे **✓ Add to books** — confirm करके लेजर में डालें।`
          hist.current.push({ role: "assistant", content: text })
          setMsgs(p => p.slice(0, -1).concat([{ role: "ai", text }]))
          window.setTimeout(
            () =>
              setMsgs(p => [
                ...p,
                {
                  role: "confirm",
                  confirmId: `nlj-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                  entries: [jr.draft],
                },
              ]),
            400
          )
          return
        }
      }

      if (recat?.type === "no_target") {
        const text = `Target category बताओ (जैसे **B2B revenue**) + date + ₹।`
        hist.current.push({ role: "assistant", content: text })
        setMsgs(p => p.slice(0, -1).concat([{ role: "ai", text }]))
        return
      }
      if (recat?.type === "no_anchor") {
        const text = `Date + ₹ amount **या** txn का name/particulars चाहिए।`
        hist.current.push({ role: "assistant", content: text })
        setMsgs(p => p.slice(0, -1).concat([{ role: "ai", text }]))
        return
      }
      if (recat?.type === "no_match") {
        const amtBit = recat.amount != null ? `**₹${inr0(recat.amount)}**` : "—"
        const d = recat.date || "—"
        const text = `No Misc line · ${amtBit} @ ${d}`
        hist.current.push({ role: "assistant", content: text })
        setMsgs(p => p.slice(0, -1).concat([{ role: "ai", text }]))
        return
      }
      if (recat?.type === "ambiguous") {
        const text = `**${recat.n}** Misc lines match — एक message में date+₹+कैटेगरी साफ करो।`
        hist.current.push({ role: "assistant", content: text })
        setMsgs(p => p.slice(0, -1).concat([{ role: "ai", text }]))
        return
      }
      if (recat?.type === "already") {
        const t = recat.t
        const text = `✓ **#${t.id}** already **${recat.target}**`
        hist.current.push({ role: "assistant", content: text })
        setMsgs(p => p.slice(0, -1).concat([{ role: "ai", text }]))
        return
      }

      const lookup = tryTxnLookupByName(msg, ledgerTxns || [])
      if (lookup?.type === "need_anchor") {
        const text = `Kis name/particulars par txn chahiye? Example: **list txn of PRATIBHA SINGH**`
        hist.current.push({ role: "assistant", content: text })
        setMsgs(p => p.slice(0, -1).concat([{ role: "ai", text }]))
        return
      }
      if (lookup?.type === "no_match") {
        const text = `**${String(lookup.anchor || "").slice(0, 60)}** के लिए कोई txn नहीं मिला। Name का थोड़ा और हिस्सा भेजो।`
        hist.current.push({ role: "assistant", content: text })
        setMsgs(p => p.slice(0, -1).concat([{ role: "ai", text }]))
        return
      }
      if (lookup?.type === "ready") {
        const lines = lookup.rows
          .map(t => `• **#${t.id}** · ${t.date} · ₹${inr0(t.amount)} · ${t.category} · ${String(t.particulars || "").slice(0, 36)}`)
          .join("\n")
        const more = lookup.total > lookup.rows.length ? `\n…और **${lookup.total - lookup.rows.length}** match(s)` : ""
        const text = `**${String(lookup.anchor || "").slice(0, 60)}** के लिए **${lookup.total}** txn मिले:\n${lines}${more}\n\nCategory बदलनी हो तो लिखो: **txn #id ko <category> karo**`
        hist.current.push({ role: "assistant", content: text })
        setMsgs(p => p.slice(0, -1).concat([{ role: "ai", text }]))
        return
      }

      const draftEntries = extractChatDraftFromUserMessage(msg)
      const hasDraft = draftEntries.length > 0
      if (hasDraft) {
        const existing = tryFindExistingTxnForDraft(msg, draftEntries, ledgerTxns || [])
        if (existing?.type === "ready") {
          const t = existing.t
          const target = existing.target
          const text = `लगता है यह txn पहले से मौजूद है: **#${t.id}** · ${t.date} · ₹${inr0(t.amount)} · ${t.category}\n\nDuplicate post करने के बजाय इसे **${target}** में बदल दूँ? नीचे **✓ Apply** दबाएँ।`
          hist.current.push({ role: "assistant", content: text })
          setMsgs(p => p.slice(0, -1).concat([{ role: "ai", text }]))
          const recatId = `rc-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
          window.setTimeout(
            () =>
              setMsgs(p => [
                ...p,
                {
                  role: "recat_confirm",
                  recatId,
                  txnId: t.id,
                  fromCat: t.category,
                  toCat: target,
                  particulars: t.particulars,
                },
              ]),
            400
          )
          return
        }
        if (existing?.type === "already") {
          const t = existing.t
          const text = `यह txn पहले से मौजूद है और सही category में है: **#${t.id}** · ${t.date} · ₹${inr0(t.amount)} · **${existing.target}**`
          hist.current.push({ role: "assistant", content: text })
          setMsgs(p => p.slice(0, -1).concat([{ role: "ai", text }]))
          return
        }
        if (existing?.type === "ambiguous") {
          const text = `Same amount के **${existing.n}** txns मिले। Date (dd/mm/yyyy) या narration जोड़ो, फिर मैं सही txn की category बदल दूँगा।`
          hist.current.push({ role: "assistant", content: text })
          setMsgs(p => p.slice(0, -1).concat([{ role: "ai", text }]))
          return
        }
      }
      let draftSummary = ""
      if (hasDraft) {
        const e = draftEntries[0]
        draftSummary =
          e.type === "CR"
            ? `**₹${inr0(e.amt)}** received — **${e.cat}** (${e.desc}).`
            : `**₹${inr0(e.amt)}** paid — **${e.cat}** (${e.desc}).`
      }
      let text
      if (hasDraft) {
        const e = draftEntries[0]
        text = `**₹${inr0(e.amt)}** · ${e.cat}\n\nनीचे **✓ Add to books** से confirm करें।`
      } else {
        text = localAccountingAssistantReply(msg.trim(), w, s, {
          draftEntries,
          draftSummary,
          assistantMemory: assistantMemory || [],
        })
      }
      hist.current.push({ role: "assistant", content: text })
      setMsgs(p => p.slice(0, -1).concat([{ role: "ai", text }]))
      if (hasDraft)
        window.setTimeout(
          () =>
            setMsgs(p => [
              ...p,
              {
                role: "confirm",
                confirmId: `r-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                entries: draftEntries,
              },
            ]),
          400
        )
    } catch (e) {
      setMsgs(p =>
        p
          .slice(0, -1)
          .concat([{ role: "ai", text: `**Error:** ${String(e?.message || e).slice(0, 220)}` }])
      )
    } finally {
    setBusy(false)
    }
  }

  const fmt = t => t ? t.split("\n").map((p,i)=><div key={i} style={{marginBottom:p?2:0}} dangerouslySetInnerHTML={{__html:p.replace(/\*\*(.*?)\*\*/g,"<strong>$1</strong>")||"<br/>"}}/>): null

  const tabBtn = active => ({
    border: "none",
    borderRadius: 8,
    padding: "5px 12px",
    fontSize: 11,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "inherit",
    background: active ? JM.p : "transparent",
    color: active ? "#fff" : "#64748b",
  })

  return (
    <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
      <div
        style={{
          flex: 1,
          background: "#ffffff",
          border: "1px solid #bae6fd",
          borderRadius: 14,
          display: "flex",
          flexDirection: "column",
          height: "calc(100vh - 156px)",
        }}
      >
        <div style={{ padding: "13px 16px", borderBottom: "1px solid #bae6fd" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 700, color: "#0c4a6e", display: "flex", alignItems: "center", gap: 8 }}>
              ✦ Indian Accounting AI Agent
              <span
                style={{
                  background: "rgba(16,185,129,.15)",
                  color: "#047857",
                  border: "1px solid rgba(16,185,129,.35)",
                  padding: "1px 8px",
                  borderRadius: 20,
                  fontSize: 9.5,
                  fontWeight: 700,
                }}
              >
                Enterprise protocol
              </span>
          </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button type="button" onClick={() => setAiTab("chat")} style={tabBtn(aiTab === "chat")}>
                Chat
              </button>
              <button type="button" onClick={() => setAiTab("bulk")} style={tabBtn(aiTab === "bulk")}>
                Bulk salary
              </button>
              <button type="button" onClick={() => setAiTab("rules")} style={tabBtn(aiTab === "rules")}>
                Rules & templates
              </button>
        </div>
          </div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 6, lineHeight: 1.45 }}>
            {aiTab === "chat"
              ? "बोलो / अपलोड → लेजर में एंट्री। Paste multi-row salary sheet here for a review card."
              : aiTab === "bulk"
                ? "Paste employee rows (Name, Amount, Type, Date) — Preview, then post all as bank debits."
                : "Rules & templates — ledger पर रन करने के लिए।"}
          </div>
          {aiTab === "chat" && Array.isArray(assistantMemory) && assistantMemory.length > 0 ? (
            <div
              style={{
                marginTop: 10,
                padding: "8px 10px",
                background: "rgba(107,122,255,.06)",
                border: "1px solid rgba(107,122,255,.2)",
                borderRadius: 8,
                fontSize: 10,
                color: "#475569",
                lineHeight: 1.45,
              }}
            >
              <div style={{ fontWeight: 800, color: "#0c4a6e", marginBottom: 6, fontSize: 10 }}>Saved notes (this company)</div>
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {assistantMemory.map((line, i) => (
                  <li key={`${i}-${String(line).slice(0, 24)}`} style={{ marginBottom: 4 }}>
                    <span style={{ wordBreak: "break-word" }}>{String(line)}</span>
                    {typeof onRemoveAssistantNote === "function" ? (
                      <button
                        type="button"
                        title="Remove"
                        onClick={() => onRemoveAssistantNote(i)}
                        style={{
                          marginLeft: 8,
                          border: "none",
                          background: "transparent",
                          color: "#94a3b8",
                          cursor: "pointer",
                          fontSize: 11,
                          padding: 0,
                          verticalAlign: "middle",
                        }}
                      >
                        ×
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              alignItems: "center",
              marginTop: 10,
              paddingTop: 10,
              borderTop: "1px solid #e0f2fe",
            }}
          >
            <input
              ref={bankFileRef}
              type="file"
              accept=".csv,.xlsx,.xls,.txt"
              style={{ display: "none" }}
              onChange={onBankStatementFile}
            />
            <button
              type="button"
              disabled={acctRole === "Viewer"}
              onClick={() => bankFileRef.current?.click()}
              style={{
                background: "#ffffff",
                border: "1px solid #bae6fd",
                borderRadius: 8,
                padding: "6px 12px",
                fontSize: 11,
                fontWeight: 700,
                color: "#0369a1",
                cursor: acctRole === "Viewer" ? "default" : "pointer",
                opacity: acctRole === "Viewer" ? 0.5 : 1,
                fontFamily: "inherit",
              }}
            >
              Upload bank statement
            </button>
            <button
              type="button"
              disabled={acctRole === "Viewer"}
              onClick={onOpenInvoiceModal}
              style={{
                background: "#ffffff",
                border: "1px solid #bae6fd",
                borderRadius: 8,
                padding: "6px 12px",
                fontSize: 11,
                fontWeight: 700,
                color: "#0369a1",
                cursor: acctRole === "Viewer" ? "default" : "pointer",
                opacity: acctRole === "Viewer" ? 0.5 : 1,
                fontFamily: "inherit",
              }}
            >
              New invoice
            </button>
            <span style={{ fontSize: 10, color: "#94a3b8", flex: "1 1 180px", minWidth: 0, lineHeight: 1.4 }}>
              Bank: CSV / XLSX from your portal (same as Bulk Upload). Invoice: opens the sales invoice form.
            </span>
          </div>
        </div>
        {aiTab === "rules" ? (
          <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
            <AssistantRulesPanel
              skills={automationSkills}
              setSkills={setAutomationSkills}
              acctRole={acctRole}
              cats={cats}
              onRunOnLedger={onRunAutomation}
              onPostTemplate={onPostTemplate}
            />
          </div>
        ) : aiTab === "bulk" ? (
          <BulkSalaryPastePanel onAddBatch={onAddBatch} acctRole={acctRole} cats={cats} onBulkSalaryPosted={onBulkSalaryPosted} />
        ) : (
          <>
        <div ref={ref} style={{flex:1,overflowY:"auto",padding:14,display:"flex",flexDirection:"column",gap:9}}>
          {msgs.map((m,i)=>{
            if (m.role === "automation_rule_confirm" && m.ruleId && m.draft) {
              return (
                <div key={m.ruleId} style={{ alignSelf: "flex-start", maxWidth: "100%" }}>
                  <ChatAutomationRuleConfirmCard
                    draft={m.draft}
                    disabled={acctRole === "Viewer"}
                    onDismiss={() => setMsgs(p => p.filter((_, j) => j !== i))}
                    onSaveOnly={() => {
                      const ok = onAutomationRuleConfirm(m.draft, false)
                      if (ok) {
                        setMsgs(p =>
                          p
                            .filter((_, j) => j !== i)
                            .concat([{ role: "ai", text: "✅ **Rule saved** — Rules & templates में दिखेगा।" }])
                        )
                      }
                    }}
                    onSaveApply={() => {
                      const ok = onAutomationRuleConfirm(m.draft, true)
                      if (ok) {
                        setMsgs(p =>
                          p
                            .filter((_, j) => j !== i)
                            .concat([
                              {
                                role: "ai",
                                text: "✅ **Rule saved** और ledger पर apply चला (जहाँ narration match हुआ)।",
                              },
                            ])
                        )
                      }
                    }}
                  />
                  </div>
              )
            }
            if (m.role === "memory_confirm" && m.memoryId) {
              return (
                <div key={m.memoryId} style={{ alignSelf: "flex-start", maxWidth: "100%" }}>
                  <ChatMemoryConfirmCard
                    note={m.noteText}
                    onDismiss={() => setMsgs(p => p.filter((_, j) => j !== i))}
                    onSave={() => {
                      const { duplicate } = onAssistantMemoryAdd(m.noteText)
                      if (duplicate) {
                        setMsgs(p =>
                          p
                            .filter((_, j) => j !== i)
                            .concat([{ role: "ai", text: "पहले से सेव है।" }])
                        )
                        return
                      }
                      setMsgs(p =>
                        p
                          .filter((_, j) => j !== i)
                          .concat([{ role: "ai", text: "✅ **Saved**" }])
                      )
                    }}
                  />
                </div>
              )
            }
            if (m.role === "recat_confirm" && m.recatId) {
              return (
                <div key={m.recatId} style={{ alignSelf: "flex-start", maxWidth: "100%" }}>
                  <ChatRecategorizeCard
                    acctRole={acctRole}
                    txnId={m.txnId}
                    fromCat={m.fromCat}
                    toCat={m.toCat}
                    particulars={m.particulars}
                    onDismiss={() => setMsgs(p => p.filter((_, j) => j !== i))}
                    onApply={() => {
                      onRecategorizeTxn(m.txnId, m.toCat)
                      setMsgs(p =>
                        p
                          .filter((_, j) => j !== i)
                          .concat([{ role: "ai", text: `✅ **Updated** txn **#${m.txnId}** → **${m.toCat}**` }])
                      )
                    }}
                  />
                </div>
              )
            }
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
          <textarea value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send(input)}}} placeholder="GST / TDS / journals · or paste a bank line + write «mark this as B2B revenue» to fix Misc" style={{...IS,resize:"none",minHeight:38,maxHeight:88,flex:1}} rows={1}/>
          <button onClick={()=>send(input)} disabled={busy} style={{background:busy?"#bae6fd":JM.p,border:"none",borderRadius:9,padding:"8px 15px",fontSize:12,fontWeight:700,color:"#fff",cursor:busy?"default":"pointer"}}>{busy?"…":"Send ↗"}</button>
        </div>
          </>
        )}
      </div>
      <div style={{width:250,display:"flex",flexDirection:"column",gap:10}}>
        <div style={{background:"#ffffff",border:"1px solid #bae6fd",borderRadius:12,padding:14}}>
          <div style={{fontSize:12,fontWeight:700,color:"#0c4a6e",marginBottom:10}}>💼 Live Financials</div>
          {(() => {
            const rows = [["Bank balance (closing)", "₹" + inr0(s.balance ?? 0), "#6B7AFF"]]
            if (s.bankLastMonthEnd != null && s.bankLastMonthEndLabel) {
              rows.push([
                `Bank @ ${s.bankLastMonthEndLabel} (month-end)`,
                "₹" + inr0(s.bankLastMonthEnd),
                "#0369a1",
              ])
            }
            if (s.repFyOpen && s.bankFyOpeningLabel && s.bankFyOpening != null) {
              rows.push([
                `Bank before ${formatFyLabel(s.repFyOpen)} (${s.bankFyOpeningLabel})`,
                "₹" + inr0(s.bankFyOpening),
                "#0c4a6e",
              ])
            }
            rows.push(
              ["Top revenue cat", (s.topRevName || "—") + " · ₹" + inr0(s.topRevAmt ?? 0), "#10b981"],
              ["Salary (DR)", "₹" + inr0(s.salaryDr ?? 0), "#f43f5e"],
              ["Output GST (est.)", "₹" + inr0(s.gstEst ?? 0), "#f59e0b"],
              ["IT refund (CR)", "₹" + inr0(s.itRefund ?? 0), "#10b981"],
              ["Transactions", String(s.count ?? 0), "#94a3b8"]
            )
            return rows.map(([k, v, c]) => (
              <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "5px 9px", background: "#ffffff", borderRadius: 7, marginBottom: 4, fontSize: 11 }}>
                <span style={{ color: "#64748b" }}>{k}</span>
                <span style={{ fontWeight: 700, color: c }}>{v}</span>
              </div>
            ))
          })()}
          <div style={{ fontSize: 9, color: "#94a3b8", marginTop: 8, lineHeight: 1.45 }}>
            Month-end &amp; FY opening use the **Balance** column from your ledger (last txn on/before that date). Set header FY filter to see “before FY”.
          </div>
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
        <div style={{ background: "#ffffff", border: "1px solid #bae6fd", borderRadius: 12, padding: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#0c4a6e", marginBottom: 8 }}>Embedded AI</div>
          <div style={{ fontSize: 10, color: "#64748b", lineHeight: 1.5 }}>
            Hindi / Hinglish / English — राशि + paid/mila → **लेजर में पोस्ट**। Misc list, step help।
          </div>
        </div>
      </div>
    </div>
  )
}

function AssistantRulesPanel({ skills, setSkills, acctRole, cats, onRunOnLedger, onPostTemplate }) {
  const card = {
    background: SKY.surface,
    border: `1px solid ${SKY.border}`,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  }
  const btnSecondary = {
    background: "transparent",
    border: `1px solid ${SKY.borderHi}`,
    borderRadius: 8,
    padding: "6px 12px",
    fontSize: 11,
    fontWeight: 600,
    color: SKY.text2,
    cursor: "pointer",
    fontFamily: "inherit",
  }
  const btnPrimary = {
    background: JM.p,
    border: "none",
    borderRadius: 8,
    padding: "6px 12px",
    fontSize: 11,
    fontWeight: 700,
    color: "#fff",
    cursor: acctRole === "Viewer" ? "default" : "pointer",
    opacity: acctRole === "Viewer" ? 0.45 : 1,
    fontFamily: "inherit",
  }
  const upd = (id, p) => setSkills(prev => prev.map(s => (s.id === id ? { ...s, ...p } : s)))
  const del = id => {
    if (AUTOMATION_DEFAULT_IDS.has(id)) return
    setSkills(prev => prev.filter(s => s.id !== id))
  }
  return (
    <div>
      <div style={card}>
        <div style={{ fontSize: 14, fontWeight: 800, color: SKY.text, marginBottom: 6 }}>Rules & templates</div>
        <div style={{ fontSize: 11, color: SKY.muted, lineHeight: 1.55, marginBottom: 12 }}>
          <strong>Match rules</strong> (optional): when enabled, they scan narration and bank remarks; the first match wins. Nothing runs until you click <strong>Run rules on full ledger</strong>. Bank import does not apply these rules.{" "}
          <strong>Templates</strong> post only when you click <strong>Post today</strong> (same checks as Add transaction).
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button type="button" disabled={acctRole === "Viewer"} onClick={onRunOnLedger} style={btnPrimary}>
            Run rules on full ledger
          </button>
          <button type="button" onClick={() => setSkills(coerceAutomationSkills([]))} style={btnSecondary}>
            Reset to defaults
          </button>
          <button
            type="button"
            onClick={() =>
              setSkills(prev => [
                ...prev,
                {
                  id: newCustomSkillId(),
                  enabled: true,
                  kind: "categorize",
                  label: "Custom rule",
                  match: "",
                  category: "Misc Expense",
                  onlyMisc: true,
                },
              ])
            }
            style={btnSecondary}
          >
            + Add match rule
          </button>
        </div>
      </div>
      {skills.map(s => (
        <div key={s.id} style={{ ...card, opacity: s.enabled ? 1 : 0.75 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12, fontWeight: 700, color: SKY.text }}>
              <input type="checkbox" checked={!!s.enabled} onChange={e => upd(s.id, { enabled: e.target.checked })} />
              {s.kind === "categorize" ? "Match → category" : "Quick post template"}
              {AUTOMATION_DEFAULT_IDS.has(s.id) ? (
                <span style={{ fontSize: 9, fontWeight: 600, color: SKY.muted, textTransform: "uppercase" }}>preset</span>
              ) : null}
            </label>
            {!AUTOMATION_DEFAULT_IDS.has(s.id) ? (
              <button type="button" onClick={() => del(s.id)} style={{ ...btnSecondary, padding: "4px 8px", fontSize: 10, color: "#f43f5e", borderColor: "#fecaca" }}>
                Remove
              </button>
            ) : null}
          </div>
          {s.kind === "categorize" ? (
            <div style={{ marginTop: 10 }}>
              <div style={{ marginBottom: 10 }}>
                <label style={LB}>Label</label>
                <input style={IS} value={s.label || ""} onChange={e => upd(s.id, { label: e.target.value })} />
              </div>
              <div style={{ marginBottom: 10 }}>
                <label style={LB}>Contains (case-insensitive)</label>
                <input
                  style={IS}
                  value={s.match || ""}
                  onChange={e => upd(s.id, { match: e.target.value })}
                  placeholder="Substring in narration or remark"
                />
              </div>
              <div style={{ marginBottom: 10 }}>
                <label style={LB}>Set category</label>
                <select style={IS} value={s.category || "Misc Expense"} onChange={e => upd(s.id, { category: e.target.value })}>
                  {cats.map(c => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: SKY.muted, cursor: "pointer" }}>
                <input type="checkbox" checked={s.onlyMisc !== false} onChange={e => upd(s.id, { onlyMisc: e.target.checked })} />
                Only when current category is Misc Expense or Misc Income
              </label>
            </div>
          ) : (
            <div style={{ marginTop: 10 }}>
              <div style={{ marginBottom: 10 }}>
                <label style={LB}>Button label</label>
                <input style={IS} value={s.label || ""} onChange={e => upd(s.id, { label: e.target.value })} />
              </div>
              <div style={{ marginBottom: 10 }}>
                <label style={LB}>Particulars (narration)</label>
                <input style={IS} value={s.particulars || ""} onChange={e => upd(s.id, { particulars: e.target.value })} />
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                <div style={{ flex: "1 1 120px" }}>
                  <label style={LB}>Amount (₹)</label>
                  <input style={IS} inputMode="decimal" value={s.amount ?? ""} onChange={e => upd(s.id, { amount: e.target.value })} />
                </div>
                <div style={{ flex: "0 0 140px" }}>
                  <label style={LB}>Bank side</label>
                  <select style={IS} value={s.drCr || "DR"} onChange={e => upd(s.id, { drCr: e.target.value })}>
                    <option value="DR">Debit (paid out)</option>
                    <option value="CR">Credit (received)</option>
                  </select>
                </div>
                <div style={{ flex: "1 1 160px" }}>
                  <label style={LB}>Category</label>
                  <select style={IS} value={s.category || "Misc Expense"} onChange={e => upd(s.id, { category: e.target.value })}>
                    {cats.map(c => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <button
                type="button"
                disabled={acctRole === "Viewer" || !isValidTemplateSkill(s, cats)}
                onClick={() => onPostTemplate(s)}
                style={btnPrimary}
              >
                {acctRole === "Viewer" ? "View-only" : "Post today"}
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ═══════════════ MAIN APP (requires login) ═══════════════
function BooksApp({ authUser, onLogout, onChangePassword }) {
  const scopedStore = useMemo(() => createScopedStore(authUser.id, store), [authUser.id])
  const [txns, setTxns] = useState(null)
  const [page, setPage] = useState("dash")
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState(null)
  const [settingsPwd, setSettingsPwd] = useState({ current: "", next: "", confirm: "" })
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [editManualClientId, setEditManualClientId] = useState(null)
  const [editClientPresetKey, setEditClientPresetKey] = useState(null)
  const [coDraft, setCoDraft] = useState(emptyCompanyFormDraft)
  const [toast, setToast] = useState(null)
  const [search, setSearch] = useState("")
  const [fCat, setFCat] = useState("")
  const [fDC, setFDC] = useState("")
  /** Transactions: narrow list to Misc Expense / Misc Income for manual recategorisation */
  const [miscRecatOnly, setMiscRecatOnly] = useState(false)
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
    qty: "1",
    unitRate: "",
    gst_rate: "18",
    sac: "998314",
    itemName: "",
    desc: "",
    subtitle: "",
    place: "intra",
    revenueCategory: REVENUE_CATS[0] || "Revenue - B2B Services",
    notes: "",
    clientPresetKey: "",
    clientAddress: "",
    clientPan: "",
  })
  const [acctRole, setAcctRole] = useState("Admin")
  const [periodLockIso, setPeriodLockIso] = useState("")
  const [automationSkills, setAutomationSkills] = useState(() => coerceAutomationSkills([]))
  /** Short free-text facts for the embedded assistant (per company; persisted in settings). */
  const [assistantMemory, setAssistantMemory] = useState([])
  /** Saved in settings — clients added from Clients page before first invoice */
  const [manualClients, setManualClients] = useState([])
  const [addClientDraft, setAddClientDraft] = useState(emptyAddClientDraft)
  const [addClientSec, setAddClientSec] = useState({
    tax: false,
    address: false,
    shipping: false,
    additional: false,
    attachments: false,
    account: false,
  })
  const [showVoid, setShowVoid] = useState(false)
  /** `key|dir` — dir is asc or desc (see sortedTxnRows) */
  const [txnSort, setTxnSort] = useState("date|desc")
  const [repFy, setRepFy] = useState("")
  const [repMonthKey, setRepMonthKey] = useState("")
  const [repFromIso, setRepFromIso] = useState("")
  const [repToIso, setRepToIso] = useState("")
  const [inventory, setInventory] = useState([])
  const [importHistory, setImportHistory] = useState([])
  const [invoices, setInvoices] = useState([])
  const [invListFilter, setInvListFilter] = useState("all")
  /** When set, invoice modal saves over this row instead of creating */
  const [invoiceModalEditId, setInvoiceModalEditId] = useState(null)
  const [invPayId, setInvPayId] = useState(null)
  const [invPayMode, setInvPayMode] = useState("add")
  const [invPayAmt, setInvPayAmt] = useState("")
  const [invPayTdsPct, setInvPayTdsPct] = useState("")
  const [dangerFlow, setDangerFlow] = useState(null)
  const [dangerRemark, setDangerRemark] = useState("")
  const [dangerAck, setDangerAck] = useState(false)
  /** { count: number } when user asked to remove all bank-import txns — confirm in modal */
  const [bankImportClearModal, setBankImportClearModal] = useState(null)
  const [companies, setCompanies] = useState([])
  const [activeCompanyId, setActiveCompanyId] = useState("")
  const skipPersistRef = useRef(false)
  const [quickAddOpen, setQuickAddOpen] = useState(false)
  const quickAddRef = useRef(null)
  /** Sidebar: Overview · Finance · Intelligence */
  const [navOpen, setNavOpen] = useState({
    overview: true,
    Finance: true,
    Intelligence: true,
  })
  /** Header + Add dropdown: collapsible groups (mirrors sidebar behaviour) */
  const [quickAddMenuOpen, setQuickAddMenuOpen] = useState({
    ledger: true,
    sales: true,
    workspace: true,
  })

  useEffect(() => {
    ;(async () => {
      try {
        // Auth-backed accounts should never inherit pre-auth legacy browser books.
        // Skipping this migration prevents new signups from seeing old/demo data
        // that may exist in shared localStorage on the same device.
        const { registry, activeCompanyId: aid, payload } = await bootstrapCompanies(scopedStore, STORAGE_EPOCH)
        setCompanies((registry.companies || []).map(c => normalizeCompanyRecord(c)).filter(Boolean))
        setActiveCompanyId(aid)
        const raw = (Array.isArray(payload.txns) ? payload.txns : []).map(t => ({ ...t, void: !!t.void }))
        setTxns(withRecalculatedBalances(applyLedgerCategoryNormalization(raw)))
        const invDoc = payload.invoices
        if (Array.isArray(invDoc))
          setInvoices(invDoc.map((row, i) => normalizeInvoiceRow({ ...row, id: row.id != null ? row.id : i + 1 })))
        else setInvoices([])
        setInventory(Array.isArray(payload.inventory) ? payload.inventory : [])
        setImportHistory(Array.isArray(payload.importHistory) ? payload.importHistory : [])
        const st = payload.settings
        if (st?.acctRole) setAcctRole(st.acctRole)
        if (st?.periodLockIso != null) setPeriodLockIso(st.periodLockIso)
        setAutomationSkills(coerceAutomationSkills(st?.automationSkills))
        setAssistantMemory(normalizeAssistantMemory(st?.assistantMemory))
        setManualClients(normalizeManualClients(st?.manualClients))
      } finally {
      setLoading(false)
      }
    })()
  }, [scopedStore])

  useEffect(() => {
    if (loading || !activeCompanyId || txns === null || skipPersistRef.current) return
    persistCompanyPayload(scopedStore, activeCompanyId, {
      txns,
      invoices,
      inventory,
      importHistory,
      settings: {
        acctRole,
        periodLockIso,
        automationSkills,
        assistantMemory: normalizeAssistantMemory(assistantMemory),
        manualClients: normalizeManualClients(manualClients),
      },
    })
  }, [txns, invoices, inventory, importHistory, acctRole, periodLockIso, automationSkills, assistantMemory, manualClients, activeCompanyId, loading, scopedStore])

  const addAssistantMemoryNote = useCallback(note => {
    const n = String(note || "").trim()
    if (!n) return { duplicate: true }
    let duplicate = false
    setAssistantMemory(prev => {
      const cur = normalizeAssistantMemory(prev)
      if (cur.some(s => s.toLowerCase() === n.toLowerCase())) {
        duplicate = true
        return cur
      }
      return normalizeAssistantMemory([...cur, n])
    })
    return { duplicate }
  }, [])

  const removeAssistantNote = useCallback(idx => {
    setAssistantMemory(prev => {
      const cur = normalizeAssistantMemory(prev)
      if (idx < 0 || idx >= cur.length) return cur
      return cur.filter((_, i) => i !== idx)
    })
  }, [])

  const appendAudit = useCallback(async entry => {
    if (!activeCompanyId) return
    await appendCompanyAudit(scopedStore, activeCompanyId, entry)
  }, [activeCompanyId, scopedStore])

  const toast_ = (msg, c="#10b981") => { setToast({msg,c}); setTimeout(()=>setToast(null),2800) }

  useEffect(() => {
    if (!quickAddOpen) return
    const onDoc = e => {
      if (quickAddRef.current && !quickAddRef.current.contains(e.target)) setQuickAddOpen(false)
    }
    const onKey = e => {
      if (e.key === "Escape") setQuickAddOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    window.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDoc)
      window.removeEventListener("keydown", onKey)
    }
  }, [quickAddOpen])

  const ledger = useMemo(() => (txns == null ? [] : txns), [txns])

  const stats = useMemo(() => {
    if (!txns) return { cr: 0, dr: 0, balance: 0, flowNet: 0, count: 0 }
    const act = ledger.filter(t => !t.void)
    const cash = act.filter(t => !t.excludeFromBankRunning)
    const cr = cash.filter(t => t.drCr === "CR").reduce((s, t) => s + t.amount, 0)
    const dr = cash.filter(t => t.drCr === "DR").reduce((s, t) => s + t.amount, 0)
    const sorted = [...act].sort((a, b) => parseDdMmYyyy(a.date) - parseDdMmYyyy(b.date) || a.id - b.id)
    const last = sorted[sorted.length - 1]
    const closing = last?.balance != null && Number.isFinite(Number(last.balance)) ? Number(last.balance) : 0
    return { cr, dr, balance: closing, flowNet: Math.round((cr - dr) * 100) / 100, count: act.length }
  }, [txns, ledger])

  /** Book bank position from journals — matches COA / trial balance (Debit − Credit on Primary bank). May differ from last row’s imported running balance. */
  const bookBankBalance = useMemo(() => {
    const { rows } = trialBalanceFromJournal(ledger)
    const r = rows.find(x => x.account === BANK_ACCOUNT)
    if (!r) return stats.balance
    return Math.round((r.debit - r.credit) * 100) / 100
  }, [ledger, stats.balance])

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

  const ledFilteredData = useMemo(() => {
    const act = reportLedger
    if (ledAcc.includes("Salary")) return act.filter(t => t.category.startsWith("Salary") && t.drCr === "DR")
    if (ledAcc.includes("Director")) return act.filter(t => t.category === "Director Payment" && t.drCr === "DR")
    if (ledAcc.includes("Revenue")) return act.filter(t => t.category.startsWith("Revenue") && t.drCr === "CR")
    if (ledAcc.includes("Vendor"))
      return act.filter(t => (t.category.startsWith("Vendor") || t.category.startsWith("Recruitment")) && t.drCr === "DR")
    if (ledAcc.includes("Capital")) return act.filter(t => t.category.startsWith("Capital") && t.drCr === "CR")
    return act
  }, [reportLedger, ledAcc])

  const ledVisibleRows = useMemo(() => ledFilteredData.slice(-80), [ledFilteredData])

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
    [ledger]
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
    const drByCat = aggregateByCategory(
      ledger.filter(t => !t.void),
      "DR"
    )
    const topDrCats = [...drByCat].sort((a, b) => b[1] - a[1]).slice(0, 8)
    const lastMonthEnd = lastCalendarMonthEndDdMmYyyy()
    const bankLastMonthEnd = bankBalanceOnOrBeforeDate(ledger, lastMonthEnd)
    const fyEnd = repFy ? fyPrevYearEndDdMmYyyy(repFy) : null
    const bankFyOpening = fyEnd ? bankBalanceOnOrBeforeDate(ledger, fyEnd) : null
    return {
      balance: bookBankBalance,
      topRevName: tr ? String(tr[0]).replace(/^Revenue -\s*/, "") : "—",
      topRevAmt: tr ? tr[1] : 0,
      salaryDr: ledger.filter(t => !t.void && t.drCr === "DR" && t.category === "Salary").reduce((s, t) => s + (Number(t.amount) || 0), 0),
      gstEst: outputGstFullBook,
      itRefund: ledger.filter(t => !t.void && t.drCr === "CR" && t.category === "Income Tax Refund").reduce((s, t) => s + (Number(t.amount) || 0), 0),
      count: stats.count,
      recentLines,
      topDrCats,
      bankLastMonthEnd,
      bankLastMonthEndLabel: lastMonthEnd,
      bankFyOpening,
      bankFyOpeningLabel: fyEnd,
      repFyOpen: repFy,
    }
  }, [ledger, bookBankBalance, stats.count, chatRevenueCats, outputGstFullBook, repFy])

  /** Month-end & pre-FY bank figures from running balance column (same logic as AI sidebar). */
  const bankSnapshotHints = useMemo(() => {
    const lastMonthEnd = lastCalendarMonthEndDdMmYyyy()
    const bankAtLastMonth = bankBalanceOnOrBeforeDate(ledger, lastMonthEnd)
    const fyEnd = repFy ? fyPrevYearEndDdMmYyyy(repFy) : null
    const bankAtFyOpen = fyEnd ? bankBalanceOnOrBeforeDate(ledger, fyEnd) : null
    return { lastMonthEnd, bankAtLastMonth, fyEnd, bankAtFyOpen }
  }, [ledger, repFy])

  const activeCompany = useMemo(() => {
    const c = companies.find(x => x.id === activeCompanyId)
    return normalizeCompanyRecord(c) || null
  }, [companies, activeCompanyId])

  /** New invoice modal: keep next # in sync when company prefix loads or invoices change (field stays empty until user types). */
  useEffect(() => {
    if (modal !== "inv" || invoiceModalEditId != null) return
    setNi(p => {
      if (p.num.trim()) return p
      return { ...p, num: suggestNextInvoiceNum(invoices, activeCompany?.invoiceSeriesPrefix) }
    })
  }, [modal, invoiceModalEditId, invoices, activeCompany?.invoiceSeriesPrefix])

  useEffect(() => {
    if (modal !== "companies") return
    const c = companies.find(x => x.id === activeCompanyId)
    if (!c) return
    setCoDraft(companyFromRegistry(c))
  }, [modal, companies, activeCompanyId])

  const flushActiveToStorage = useCallback(async () => {
    if (!activeCompanyId || txns === null) return
    await persistCompanyPayload(scopedStore, activeCompanyId, {
      txns,
      invoices,
      inventory,
      importHistory,
      settings: {
        acctRole,
        periodLockIso,
        automationSkills,
        assistantMemory: normalizeAssistantMemory(assistantMemory),
        manualClients: normalizeManualClients(manualClients),
      },
    })
  }, [activeCompanyId, txns, invoices, inventory, importHistory, acctRole, periodLockIso, automationSkills, assistantMemory, manualClients, scopedStore])

  const applyLoadedPayload = useCallback(payload => {
    const raw = (Array.isArray(payload.txns) ? payload.txns : []).map(t => ({ ...t, void: !!t.void }))
    setTxns(withRecalculatedBalances(applyLedgerCategoryNormalization(raw)))
    const invDoc = payload.invoices
    if (Array.isArray(invDoc))
      setInvoices(invDoc.map((row, i) => normalizeInvoiceRow({ ...row, id: row.id != null ? row.id : i + 1 })))
    else setInvoices([])
    setInventory(Array.isArray(payload.inventory) ? payload.inventory : [])
    setImportHistory(Array.isArray(payload.importHistory) ? payload.importHistory : [])
    const st = payload.settings
    setAcctRole(st?.acctRole || "Admin")
    setPeriodLockIso(st?.periodLockIso != null ? st.periodLockIso : "")
    setAutomationSkills(coerceAutomationSkills(st?.automationSkills))
    setAssistantMemory(normalizeAssistantMemory(st?.assistantMemory))
    setManualClients(normalizeManualClients(st?.manualClients))
  }, [])

  const switchCompany = useCallback(
    async newId => {
      if (!newId || newId === activeCompanyId || loading) return
      skipPersistRef.current = true
      try {
        await flushActiveToStorage()
        const reg = (await readRegistry(scopedStore)) || { companies: [], activeCompanyId: "" }
        const nextReg = { ...reg, activeCompanyId: newId }
        await writeRegistry(scopedStore, nextReg)
        const payload = await loadCompanyPayload(scopedStore, newId)
        setActiveCompanyId(newId)
        setCompanies((nextReg.companies || []).map(c => normalizeCompanyRecord(c)).filter(Boolean))
        applyLoadedPayload(payload)
        toast_("Switched company workspace", "#6B7AFF")
      } catch (e) {
        toast_(String(e?.message || e), "#f43f5e")
      } finally {
        skipPersistRef.current = false
      }
    },
    [activeCompanyId, loading, flushActiveToStorage, applyLoadedPayload, scopedStore]
  )

  const addCompany = useCallback(async () => {
    const name = prompt("Company / workspace name (shown in the app header)")
    if (name == null) return
    const trimmed = name.trim() || "New company"
    skipPersistRef.current = true
    try {
      await flushActiveToStorage()
      const id = newCompanyId()
      const reg = (await readRegistry(scopedStore)) || { version: 1, companies, activeCompanyId }
      const nextReg = {
        ...reg,
        companies: [...(reg.companies || []), { id, ...emptyCompanyFormDraft(), name: trimmed }],
        activeCompanyId: id,
      }
      await writeRegistry(scopedStore, nextReg)
      await persistCompanyPayload(scopedStore, id, {
        txns: [],
        invoices: [],
        inventory: [],
        importHistory: [],
        settings: { acctRole: "Admin", periodLockIso: "", automationSkills: coerceAutomationSkills([]), assistantMemory: [], manualClients: [] },
      })
      const payload = await loadCompanyPayload(scopedStore, id)
      setActiveCompanyId(id)
      setCompanies(nextReg.companies.map(c => normalizeCompanyRecord(c)).filter(Boolean))
      applyLoadedPayload(payload)
      toast_("New company added — empty books", "#10b981")
    } catch (e) {
      toast_(String(e?.message || e), "#f43f5e")
    } finally {
      skipPersistRef.current = false
    }
  }, [activeCompanyId, companies, flushActiveToStorage, applyLoadedPayload, scopedStore])

  const saveCompanyProfile = useCallback(
    async (id, patch) => {
      const reg = await readRegistry(scopedStore)
      if (!reg?.companies) return
      const next = {
        ...reg,
        companies: reg.companies.map(c => (c.id === id ? { ...c, ...patch } : c)),
      }
      await writeRegistry(scopedStore, next)
      setCompanies(next.companies.map(c => normalizeCompanyRecord(c)).filter(Boolean))
      toast_("Company details saved", "#10b981")
    },
    [scopedStore]
  )

  const savePasswordFromSettings = useCallback(async () => {
    const currentPassword = String(settingsPwd.current || "")
    const newPassword = String(settingsPwd.next || "")
    const confirmPassword = String(settingsPwd.confirm || "")
    if (!currentPassword || !newPassword || !confirmPassword) {
      toast_("Please fill all password fields", "#f43f5e")
      return
    }
    if (newPassword.length < 8) {
      toast_("New password must be at least 8 characters", "#f43f5e")
      return
    }
    if (newPassword !== confirmPassword) {
      toast_("New password and confirm password do not match", "#f43f5e")
      return
    }
    if (newPassword === currentPassword) {
      toast_("New password must be different from current password", "#f43f5e")
      return
    }
    if (typeof onChangePassword !== "function") {
      toast_("Password change is not available right now", "#f43f5e")
      return
    }
    try {
      setSettingsSaving(true)
      await onChangePassword(currentPassword, newPassword)
      setSettingsPwd({ current: "", next: "", confirm: "" })
      toast_("Password changed successfully", "#10b981")
    } catch (e) {
      toast_(String(e?.message || "Could not change password"), "#f43f5e")
    } finally {
      setSettingsSaving(false)
    }
  }, [settingsPwd, onChangePassword])

  const deleteCompany = useCallback(
    async id => {
      if (companies.length <= 1) {
        toast_("Keep at least one company workspace", "#f43f5e")
        return
      }
      if (!confirm("Delete this company and all its books, invoices, and history? This cannot be undone.")) return
      skipPersistRef.current = true
      try {
        const reg = await readRegistry(scopedStore)
        if (!reg?.companies) return
        const rest = reg.companies.filter(c => c.id !== id)
        if (!rest.length) return
        if (id === reg.activeCompanyId) {
          await removeCompanyData(scopedStore, id)
          const nextActive = rest[0].id
          const nextReg = { ...reg, companies: rest, activeCompanyId: nextActive }
          await writeRegistry(scopedStore, nextReg)
          const payload = await loadCompanyPayload(scopedStore, nextActive)
          setActiveCompanyId(nextActive)
          setCompanies(rest.map(c => normalizeCompanyRecord(c)).filter(Boolean))
          applyLoadedPayload(payload)
        } else {
          await removeCompanyData(scopedStore, id)
          const nextReg = { ...reg, companies: rest }
          await writeRegistry(scopedStore, nextReg)
          setCompanies(rest.map(c => normalizeCompanyRecord(c)).filter(Boolean))
        }
        toast_("Company removed", "#f59e0b")
      } catch (e) {
        toast_(String(e?.message || e), "#f43f5e")
      } finally {
        skipPersistRef.current = false
      }
    },
    [companies.length, applyLoadedPayload, scopedStore]
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

  const updateTxnCategoryFromMisc = useCallback(
    (id, newCategory) => {
      if (acctRole === "Viewer") {
        toast_("Viewer role — cannot edit categories", "#f43f5e")
        return
      }
      if (!txns?.length || !CATS.includes(newCategory)) return
      const t = txns.find(x => x.id === id)
      if (!t) return
      if (t.void) {
        toast_("Voided rows cannot be recategorised", "#f59e0b")
        return
      }
      if (t.category !== "Misc Expense" && t.category !== "Misc Income") {
        toast_("Only rows still on Misc Expense / Misc Income can be changed here", "#94a3b8")
        return
      }
      if (periodLockIso && isPeriodLocked(t.date, periodLockIso)) {
        toast_("This date is in a locked period — unlock or pick another row", "#f43f5e")
        return
      }
      if (newCategory === t.category) return
      const jl = buildJournalLines({ amount: t.amount, drCr: t.drCr, category: newCategory })
      const v = validateBalanced(jl)
      if (!v.ok) {
        toast_(v.errors[0] || "Journal would be unbalanced for this category", "#f43f5e")
        return
      }
      const patched = enrichTxnJournal({ ...t, category: newCategory, journalLines: undefined })
      setTxns(withRecalculatedBalances(txns.map(x => (x.id === id ? patched : x))))
      appendAudit({
        action: "RECATEGORY_MISC",
        txnId: id,
        from: t.category,
        to: newCategory,
        by: acctRole,
        particulars: t.particulars?.slice(0, 120),
      })
      toast_(`Category updated → ${newCategory}`, "#10b981")
    },
    [txns, acctRole, periodLockIso, appendAudit]
  )

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

  const runAutomationOnLedger = useCallback(() => {
    if (acctRole === "Viewer") {
      toast_("Viewer role — cannot change ledger", "#f43f5e")
      return
    }
    if (!txns?.length) {
      toast_("No transactions in this workspace", "#f59e0b")
      return
    }
    const { txns: step1, changed: skillHits } = applyCategorizationSkills(
      txns.map(t => ({ ...t })),
      automationSkills,
      { allowedCategories: CATS }
    )
    if (!ledgerVisualChanged(txns, step1)) {
      toast_("No rows matched your enabled rules (turn rules on under each card, or add a custom match)", "#94a3b8")
      return
    }
    const pmap = Object.fromEntries(txns.map(t => [t.id, t]))
    const updated = step1.filter(t => {
      const p = pmap[t.id]
      return !p || p.category !== t.category || JSON.stringify(p.journalLines) !== JSON.stringify(t.journalLines)
    }).length
    setTxns(withRecalculatedBalances(step1))
    appendAudit({ action: "AUTOMATION_RULES", by: acctRole, updated, skillRuleHits: skillHits })
    toast_(`Applied enabled rules: ${updated} line(s) updated (${skillHits} match hits)`, "#10b981")
  }, [txns, automationSkills, acctRole, appendAudit])

  const confirmAutomationRuleFromChat = useCallback(
    (draft, applyLedger) => {
      if (acctRole === "Viewer") return false
      const skill = {
        id: newCustomSkillId(),
        enabled: true,
        kind: "categorize",
        label: String(draft.label || "").slice(0, 120),
        match: String(draft.match || "").trim().slice(0, 120),
        category: draft.category,
        onlyMisc: false,
      }
      if (!isValidCategorizeSkill(skill, CATS)) return false
      const mergedSkills = [...coerceAutomationSkills(automationSkills), skill]
      setAutomationSkills(mergedSkills)
      if (applyLedger && txns?.length) {
        const { txns: step1, changed: skillHits } = applyCategorizationSkills(
          txns.map(t => ({ ...t })),
          mergedSkills,
          { allowedCategories: CATS }
        )
        if (!ledgerVisualChanged(txns, step1)) {
          toast_("Rule saved — abhi koi line match नहीं (narration में keyword जोड़कर देखें)", "#94a3b8")
          return true
        }
        const pmap = Object.fromEntries(txns.map(t => [t.id, t]))
        const updated = step1.filter(t => {
          const p = pmap[t.id]
          return !p || p.category !== t.category || JSON.stringify(p.journalLines) !== JSON.stringify(t.journalLines)
        }).length
        setTxns(withRecalculatedBalances(step1))
        appendAudit({ action: "AUTOMATION_RULES", by: acctRole, updated, skillRuleHits: skillHits })
        toast_(`Rule saved · ${updated} line(s) updated (${skillHits} hits)`, "#10b981")
      }
      return true
    },
    [acctRole, automationSkills, txns, appendAudit]
  )

  const postAutomationTemplate = useCallback(
    s => {
      if (acctRole === "Viewer") return
      if (!isValidTemplateSkill(s, CATS)) {
        toast_("Check template fields (amount, particulars, category)", "#f43f5e")
        return
      }
      addTxn({
        date: todayISO(),
        particulars: String(s.particulars).trim(),
        amount: String(s.amount),
        drCr: s.drCr === "CR" ? "Credit" : "Debit",
        category: s.category,
        ref: `auto:${s.id}`,
      })
    },
    [acctRole, addTxn]
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
        let merged = [...txns, ...res.newTxns]
        merged = applyLedgerCategoryNormalization(merged)
        setTxns(withRecalculatedBalances(merged))
        appendAudit({
          action: "BULK_IMPORT",
          by: acctRole,
          file: f.name,
          count: res.newTxns.length,
          stats: res.stats,
        })
        toast_(`✓ ${res.newTxns.length} imported`, "#10b981")
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

  const requestRemoveBankImportTransactions = useCallback(() => {
    if (acctRole === "Viewer") {
      toast_("Viewer role — cannot modify ledger", "#f43f5e")
      return
    }
    if (!txns?.length) return
    const n = txns.filter(t => isTxnFromBankFileImport(t)).length
    if (!n) {
      toast_("No tagged bank-import rows found. Older data may not have import tags.", "#94a3b8")
      return
    }
    setBankImportClearModal({ count: n })
  }, [txns, acctRole])

  const confirmRemoveBankImportTransactions = useCallback(() => {
    setBankImportClearModal(null)
    if (acctRole === "Viewer") return
    if (!txns?.length) return
    const toRemove = txns.filter(t => isTxnFromBankFileImport(t))
    if (!toRemove.length) return
    const kept = txns.filter(t => !isTxnFromBankFileImport(t))
    setTxns(withRecalculatedBalances(kept))
    setImportHistory([])
    appendAudit({ action: "CLEAR_BANK_IMPORTS", by: acctRole, removed: toRemove.length })
    toast_(`Removed ${toRemove.length} bank-import line(s). You can upload the statement again.`, "#10b981")
  }, [txns, acctRole, appendAudit])

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
      setTxns(prev => syncLedgerWithInvoicePaymentState(prev, { ...inv, paidAmount: 0, paidBankTotal: 0, paidTdsTotal: 0 }, { createdBy: acctRole }))
      setInvoices(list => list.filter(i => i.id !== id))
      appendAudit({
        action: "INVOICE_DELETE",
        invoiceId: id,
        num: inv.num,
        remark,
      })
      toast_("Invoice removed · ledger settlement lines for this invoice cleared", "#f59e0b")
    }
    closeDangerModal()
  }, [acctRole, dangerFlow, dangerRemark, dangerAck, invoices, txns, appendAudit, closeDangerModal])

  const openCreateInvoiceModal = () => {
    if (acctRole === "Viewer") {
      toast_("Viewer role — cannot create invoices", "#f43f5e")
      return
    }
    setInvoiceModalEditId(null)
    const d = todayISO()
    setNi({
      num: suggestNextInvoiceNum(invoices, activeCompany?.invoiceSeriesPrefix),
      date: d,
      dueDays: "30",
      dueDate: addDaysISO(d, 30),
      client: "",
      gstin: "",
      qty: "1",
      unitRate: "",
      gst_rate: "18",
      sac: "998314",
      itemName: "",
      desc: "",
      subtitle: "",
      place: "intra",
      revenueCategory: REVENUE_CATS[0] || "Revenue - B2B Services",
      notes: "",
      clientPresetKey: "",
      clientAddress: "",
      clientPan: "",
    })
    setModal("inv")
  }

  const openEditInvoiceModal = inv => {
    if (acctRole === "Viewer") {
      toast_("Viewer role — cannot edit invoices", "#f43f5e")
      return
    }
    const d0 = Date.parse(inv.date)
    const d1 = Date.parse(inv.dueDate)
    const dd = Number.isFinite(d0) && Number.isFinite(d1) ? Math.max(0, Math.round((d1 - d0) / 86400000)) : 30
    setInvoiceModalEditId(inv.id)
    const split = splitStoredInvoiceDesc(inv.desc)
    const t = Number(inv.taxable) || 0
    const q = Number(inv.qty) > 0 ? Number(inv.qty) : 1
    const ur = q > 0 ? t / q : t
    setNi({
      num: inv.num,
      date: inv.date,
      dueDays: String(dd),
      dueDate: inv.dueDate || inv.date,
      client: inv.client,
      gstin: inv.gstin,
      qty: String(q),
      unitRate: ur ? String(Number.isFinite(ur) ? Math.round(ur * 1e6) / 1e6 : ur) : "",
      gst_rate: String(inv.gst_rate ?? "18"),
      sac: inv.sac || "998314",
      itemName: split.itemName,
      desc: split.descExtra,
      subtitle: inv.subtitle || "",
      place: inv.place === "inter" ? "inter" : "intra",
      revenueCategory: inv.revenueCategory || REVENUE_CATS[0] || "Revenue - B2B Services",
      notes: inv.notes || "",
      clientPresetKey: "",
      clientAddress: String(inv.clientAddress || ""),
      clientPan: String(inv.clientPan || ""),
    })
    setModal("inv")
  }

  const duplicateInvoice = inv => {
    if (acctRole === "Viewer") return
    const nextNum = suggestNextInvoiceNum(invoices, activeCompany?.invoiceSeriesPrefix)
    const d = todayISO()
    const g = computeInvoiceGst(inv.taxable, inv.gst_rate, inv.place)
    const copy = normalizeInvoiceRow({
      id: Math.max(0, ...invoices.map(x => x.id)) + 1,
      num: nextNum,
      date: d,
      dueDate: addDaysISO(d, 30),
      client: inv.client,
      gstin: inv.gstin,
      sac: inv.sac || "998314",
      qty: Number(inv.qty) > 0 ? Number(inv.qty) : 1,
      taxable: inv.taxable,
      gst_rate: inv.gst_rate,
      cgst: g.cgst,
      sgst: g.sgst,
      igst: g.igst,
      total: g.total,
      desc: inv.desc,
      place: inv.place,
      revenueCategory: inv.revenueCategory,
      notes: inv.notes || "",
      subtitle: inv.subtitle || "",
      clientAddress: String(inv.clientAddress || ""),
      clientPan: String(inv.clientPan || ""),
      status: "sent",
      paidAmount: 0,
      paidBankTotal: 0,
      paidTdsTotal: 0,
      paidAt: "",
      createdAt: new Date().toISOString(),
    })
    setInvoices(h => [...h, copy])
    appendAudit({ action: "INVOICE_DUPLICATE", invoiceId: copy.id, fromId: inv.id, num: copy.num })
    toast_("Duplicated as " + nextNum + " · ₹" + inr(copy.total), "#10b981")
  }

  const closeQuickAdd = () => setQuickAddOpen(false)

  const onQuickAddTxn = () => {
    if (acctRole === "Viewer") {
      toast_("Viewer role — cannot post entries", "#f43f5e")
      closeQuickAdd()
      return
    }
    setNt({
      date: todayISO(),
      particulars: pickSuggestedParticulars(txns, "Misc Expense", "Debit"),
      amount: "",
      drCr: "Debit",
      category: "Misc Expense",
      ref: "",
    })
    setPage("txn")
    setModal("txn")
    closeQuickAdd()
  }

  const onQuickAddVendor = () => {
    if (acctRole === "Viewer") {
      toast_("Viewer role — cannot post entries", "#f43f5e")
      closeQuickAdd()
      return
    }
    setNt({
      date: todayISO(),
      particulars: pickSuggestedParticulars(txns, "Vendor - Other", "Debit"),
      amount: "",
      drCr: "Debit",
      category: "Vendor - Other",
      ref: "",
    })
    setPage("txn")
    setModal("txn")
    closeQuickAdd()
  }

  const onQuickAddNewClient = () => {
    if (acctRole === "Viewer") {
      toast_("Viewer role — cannot create invoices", "#f43f5e")
      closeQuickAdd()
      return
    }
    setPage("clients")
    closeQuickAdd()
  }

  const onQuickAddInvoiceOnly = () => {
    if (acctRole === "Viewer") {
      toast_("Viewer role — cannot create invoices", "#f43f5e")
      closeQuickAdd()
      return
    }
    setPage("inv")
    openCreateInvoiceModal()
    closeQuickAdd()
  }

  const onQuickAddEmployee = () => {
    if (acctRole === "Viewer") {
      toast_("Viewer role — cannot post entries", "#f43f5e")
      closeQuickAdd()
      return
    }
    setPage("pay")
    setModal("emp")
    closeQuickAdd()
  }

  const onQuickAddItem = () => {
    if (acctRole === "Viewer") {
      toast_("Viewer role — cannot post entries", "#f43f5e")
      closeQuickAdd()
      return
    }
    setPage("stock")
    setModal("item")
    closeQuickAdd()
  }

  const onQuickAddCompany = () => {
    setModal("companies")
    closeQuickAdd()
  }

  const invoiceClientPresets = useMemo(
    () => mergeManualClientsIntoPresets(manualClients, invoiceClientPresetsFromList(invoices)),
    [manualClients, invoices]
  )

  const invoiceDescSuggestions = useMemo(() => {
    const seen = new Set()
    const out = []
    for (const inv of invoices || []) {
      const t = String(splitStoredInvoiceDesc(inv.desc).descExtra || "").trim()
      if (t && !seen.has(t)) {
        seen.add(t)
        out.push(t)
        if (out.length >= 24) break
      }
    }
    return out
  }, [invoices])

  useEffect(() => {
    if (modal !== "addClient") return
    setAddClientSec({
      tax: false,
      address: false,
      shipping: false,
      additional: false,
      attachments: false,
      account: false,
    })
    if (editManualClientId != null) {
      const m = manualClients.find(x => x.id === editManualClientId)
      if (m) setAddClientDraft(manualClientToDraft(m))
      return
    }
    if (editClientPresetKey != null) {
      const m = manualClients.find(x => manualClientKey(x) === editClientPresetKey)
      if (m) {
        setAddClientDraft(manualClientToDraft(m))
        return
      }
      const p = invoiceClientPresets.find(x => x.key === editClientPresetKey)
      setAddClientDraft(presetToAddClientDraft(p))
      return
    }
    setAddClientDraft(emptyAddClientDraft())
  }, [modal, editManualClientId, editClientPresetKey, manualClients, invoiceClientPresets])

  const saveAddClientFromModal = () => {
    if (acctRole === "Viewer") return
    const name = addClientDraft.client.trim()
    if (!name) {
      toast_("Enter business name", "#f43f5e")
      return
    }
    const country = String(addClientDraft.country || "").trim()
    if (!country) {
      toast_("Select country", "#f43f5e")
      return
    }
    const gst = String(addClientDraft.gstin || "").trim().toUpperCase()
    const newKey = `${name.toLowerCase()}\n${gst}`
    const placeFinal = addClientDraft.place === "inter" ? "inter" : "intra"
    const isEdit = editManualClientId != null || editClientPresetKey != null
    const oldKey = editClientPresetKey

    const dupMan = manualClients.some(m => manualClientKey(m) === newKey && m.id !== (editManualClientId ?? -1))
    const dupInv = invoices.some(inv => {
      if (clientKeyInv(inv) !== newKey) return false
      if (oldKey != null && clientKeyInv(inv) === oldKey) return false
      return true
    })
    if (dupMan || dupInv) {
      toast_("This client already exists", "#f59e0b")
      return
    }

    const nextId = Math.max(0, ...manualClients.map(m => Number(m.id) || 0), 0) + 1
    const base = {
      id: nextId,
      client: name,
      gstin: String(addClientDraft.gstin || "").trim(),
      place: placeFinal,
      createdAt: new Date().toISOString(),
      clientIndustry: String(addClientDraft.clientIndustry || "").trim(),
      country: String(addClientDraft.country || "India").trim() || "India",
      city: String(addClientDraft.city || "").trim(),
      logoDataUrl: typeof addClientDraft.logoDataUrl === "string" ? addClientDraft.logoDataUrl : "",
      pan: String(addClientDraft.pan || "").trim(),
      addrLine1: String(addClientDraft.addrLine1 || "").trim(),
      addrLine2: String(addClientDraft.addrLine2 || "").trim(),
      state: String(addClientDraft.state || "").trim(),
      pin: String(addClientDraft.pin || "").trim(),
      shipLine1: String(addClientDraft.shipLine1 || "").trim(),
      shipLine2: String(addClientDraft.shipLine2 || "").trim(),
      shipState: String(addClientDraft.shipState || "").trim(),
      shipPin: String(addClientDraft.shipPin || "").trim(),
      shipSame: addClientDraft.shipSame !== false,
      additionalNotes: String(addClientDraft.additionalNotes || "").trim(),
      bankName: String(addClientDraft.bankName || "").trim(),
      accountNumber: String(addClientDraft.accountNumber || "").trim(),
      ifsc: String(addClientDraft.ifsc || "").trim(),
      creditLimit: String(addClientDraft.creditLimit || "").trim(),
    }

    if (!isEdit) {
      setManualClients(h => [...h, normalizeManualClients([base])[0]])
      appendAudit({ action: "CLIENT_ADD", client: name })
      toast_("Client saved — create an invoice when you’re ready", "#10b981")
      setModal(null)
      return
    }

    if (oldKey != null && invoices.some(inv => clientKeyInv(inv) === oldKey)) {
      setInvoices(h =>
        h.map(inv =>
          clientKeyInv(inv) === oldKey
            ? normalizeInvoiceRow({
                ...inv,
                client: name,
                gstin: String(addClientDraft.gstin || "").trim(),
                place: placeFinal,
              })
            : inv
        )
      )
    }

    if (editManualClientId != null) {
      const prev = manualClients.find(m => m.id === editManualClientId)
      const row = {
        ...base,
        id: editManualClientId,
        createdAt: prev?.createdAt || new Date().toISOString(),
      }
      setManualClients(h => h.map(m => (m.id === editManualClientId ? normalizeManualClients([row])[0] : m)))
    }

    appendAudit({ action: "CLIENT_EDIT", client: name })
    toast_("Client updated", "#10b981")
    setModal(null)
    setEditManualClientId(null)
    setEditClientPresetKey(null)
  }

  const onAddClientLogoFile = e => {
    const f = e.target.files?.[0]
    if (!f) return
    if (f.size > 20 * 1024 * 1024) {
      toast_("Max file size 20MB", "#f59e0b")
      e.target.value = ""
      return
    }
    if (!/^image\/(jpeg|png)$/i.test(f.type)) {
      toast_("Use JPG or PNG only", "#f59e0b")
      e.target.value = ""
      return
    }
    const r = new FileReader()
    r.onload = () => {
      const url = String(r.result || "")
      const img = new Image()
      img.onload = () => {
        if (img.width > 1080 || img.height > 1080) {
          toast_("Image dimensions should be ≤ 1080×1080px", "#f59e0b")
          e.target.value = ""
          return
        }
        if (url.length > 400000) {
          toast_("Use a smaller image (under ~300KB) for reliable browser sync", "#f59e0b")
          e.target.value = ""
          return
        }
        setAddClientDraft(p => ({ ...p, logoDataUrl: url }))
      }
      img.onerror = () => {
        toast_("Could not read image", "#f43f5e")
        e.target.value = ""
      }
      img.src = url
    }
    r.readAsDataURL(f)
  }

  const onCompanyLogoFile = e => {
    const f = e.target.files?.[0]
    if (!f) return
    if (f.size > 20 * 1024 * 1024) {
      toast_("Max file size 20MB", "#f59e0b")
      e.target.value = ""
      return
    }
    if (!/^image\/(jpeg|png)$/i.test(f.type)) {
      toast_("Use JPG or PNG only", "#f59e0b")
      e.target.value = ""
      return
    }
    const r = new FileReader()
    r.onload = () => {
      const url = String(r.result || "")
      const img = new Image()
      img.onload = () => {
        if (img.width > 1080 || img.height > 1080) {
          toast_("Image dimensions should be ≤ 1080×1080px", "#f59e0b")
          e.target.value = ""
          return
        }
        if (url.length > 400000) {
          toast_("Use a smaller image (under ~300KB) for reliable browser sync", "#f59e0b")
          e.target.value = ""
          return
        }
        setCoDraft(p => ({ ...p, logoDataUrl: url }))
      }
      img.onerror = () => {
        toast_("Could not read image", "#f43f5e")
        e.target.value = ""
      }
      img.src = url
    }
    r.readAsDataURL(f)
  }

  const applyInvoiceClientPresetKey = useCallback(
    key => {
      if (!key) {
        setNi(p => ({ ...p, clientPresetKey: "" }))
        return
      }
      const row = invoiceClientPresets.find(p => p.key === key)
      if (!row) {
        setNi(p => ({ ...p, clientPresetKey: "" }))
        return
      }
      const manual = manualClients.find(m => manualClientKey(m) === key)
      const clientAddress = manual ? formatManualClientAddressForInvoice(manual) : String(row.clientAddress || "")
      const clientPan = manual ? String(manual.pan || "").trim() : String(row.clientPan || "")
      setNi(p => {
        const base = {
          ...p,
          clientPresetKey: key,
          client: row.client,
          gstin: row.gstin,
          place: row.place,
          sac: row.sac,
          revenueCategory: row.revenueCategory,
          clientAddress,
          clientPan,
        }
        const sug = suggestDueFromLastClientInvoice(invoices, row.client, row.gstin, p.date)
        if (sug) return { ...base, dueDays: sug.dueDays, dueDate: sug.dueDate }
        return base
      })
    },
    [invoiceClientPresets, manualClients, invoices]
  )

  const maybeApplyClientDueFromHistory = useCallback(() => {
    if (modal !== "inv" || invoiceModalEditId != null) return
    setNi(p => {
      const sug = suggestDueFromLastClientInvoice(invoices, p.client, p.gstin, p.date)
      if (!sug) return p
      const expectedDue = addDaysISO(p.date, parseInt(p.dueDays, 10) || 30)
      if (p.dueDate !== expectedDue) return p
      return { ...p, dueDays: sug.dueDays, dueDate: sug.dueDate }
    })
  }, [modal, invoiceModalEditId, invoices])

  const saveInvoiceFromModal = () => {
    if (acctRole === "Viewer") return
    const taxable = lineTaxableFromNi(ni)
    const g = computeInvoiceGst(taxable, ni.gst_rate, ni.place)
    const numFinal = (ni.num.trim() || suggestNextInvoiceNum(invoices, activeCompany?.invoiceSeriesPrefix)).trim()
    const qtySaved = parseInvoiceQty(ni.qty)
    if (!ni.client.trim()) {
      toast_("Enter client name", "#f43f5e")
      return
    }
    if (!taxable || taxable <= 0) {
      toast_("Enter quantity × rate (taxable value pre-GST)", "#f43f5e")
      return
    }
    if (invoices.some(x => x.num === numFinal && x.id !== invoiceModalEditId)) {
      toast_("Duplicate invoice #", "#f43f5e")
      return
    }
    const dueDate = ni.dueDate || addDaysISO(ni.date, parseInt(ni.dueDays, 10) || 30)

    if (invoiceModalEditId != null) {
      const prev = invoices.find(x => x.id === invoiceModalEditId)
      if (!prev) {
        toast_("Invoice not found", "#f43f5e")
        return
      }
      const tot = g.total
      const cap = Math.max(0, tot)
      const prevPaid = Math.min(Number(prev.paidAmount) || 0, cap)
      const prevBank = Math.min(Number(prev.paidBankTotal ?? prev.paidAmount) || 0, cap)
      const prevTds = Math.min(Number(prev.paidTdsTotal) || 0, Math.max(0, cap - prevBank))
      const next = normalizeInvoiceRow({
        ...prev,
        num: numFinal,
        date: ni.date,
        dueDate,
        client: ni.client.trim(),
        gstin: ni.gstin.trim(),
        sac: ni.sac.trim(),
        qty: qtySaved,
        taxable,
        gst_rate: parseFloat(ni.gst_rate) || 0,
        cgst: g.cgst,
        sgst: g.sgst,
        igst: g.igst,
        total: tot,
        desc: combineInvoiceDesc(ni),
        subtitle: String(ni.subtitle || "").trim(),
        place: ni.place,
        revenueCategory: ni.revenueCategory,
        notes: ni.notes || "",
        clientAddress: String(ni.clientAddress || "").trim(),
        clientPan: String(ni.clientPan || "").trim(),
        paidAmount: prevPaid,
        paidBankTotal: prevBank,
        paidTdsTotal: prevTds,
        paidAt: prev.paidAt,
        status: prevPaid >= cap - 0.01 ? "paid" : prev.status || "sent",
      })
      setTxns(prevTx => syncLedgerWithInvoicePaymentState(prevTx, next, { createdBy: acctRole }))
      setInvoices(list => list.map(x => (x.id === invoiceModalEditId ? next : x)))
      appendAudit({ action: "INVOICE_UPDATE", invoiceId: next.id, num: next.num, total: next.total })
      toast_("Updated · " + next.num + " · ₹" + inr(next.total), "#10b981")
      setInvoiceModalEditId(null)
      setModal(null)
      return
    }

    const inv = normalizeInvoiceRow({
      id: Math.max(0, ...invoices.map(x => x.id)) + 1,
      num: numFinal,
      date: ni.date,
      dueDate,
      client: ni.client.trim(),
      gstin: ni.gstin.trim(),
      sac: ni.sac.trim(),
      qty: qtySaved,
      taxable,
      gst_rate: parseFloat(ni.gst_rate) || 0,
      cgst: g.cgst,
      sgst: g.sgst,
      igst: g.igst,
      total: g.total,
      desc: combineInvoiceDesc(ni),
      subtitle: String(ni.subtitle || "").trim(),
      place: ni.place,
      revenueCategory: ni.revenueCategory,
      notes: ni.notes || "",
      clientAddress: String(ni.clientAddress || "").trim(),
      clientPan: String(ni.clientPan || "").trim(),
      status: "sent",
      paidAmount: 0,
      paidBankTotal: 0,
      paidTdsTotal: 0,
      paidAt: "",
      createdAt: new Date().toISOString(),
    })
    setInvoices(h => [...h, inv])
    const dirKey = `${ni.client.trim().toLowerCase()}\n${String(ni.gstin || "").trim().toUpperCase()}`
    setManualClients(prev => prev.filter(m => `${String(m.client || "").trim().toLowerCase()}\n${String(m.gstin || "").trim().toUpperCase()}` !== dirKey))
    appendAudit({ action: "INVOICE_CREATE", invoiceId: inv.id, num: inv.num, total: inv.total })
    toast_("Saved · " + inv.num + " · ₹" + inr(inv.total), "#10b981")
    setModal(null)
  }

  const printInvoiceDraft = () => {
    const taxable = lineTaxableFromNi(ni)
    const g = computeInvoiceGst(taxable, ni.gst_rate, ni.place)
    const co = activeCompany
    const lineLabel = String(ni.itemName || "").trim() || "Line item"
    const lineDetail = String(ni.desc || "").trim()
    const gstPct = String(ni.gst_rate || "0")
    const place = ni.place === "inter" ? "inter" : "intra"
    const dueDate = ni.dueDate || addDaysISO(ni.date, parseInt(ni.dueDays, 10) || 30)
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Invoice ${escapeHtml(String(ni.num))}</title>
<style>${INVOICE_PRINT_STYLESHEET}</style></head><body>
${buildInvoicePrintDocumentHtml({
      co,
      num: ni.num,
      date: ni.date,
      dueDate,
      subtitle: ni.subtitle,
      place,
      client: ni.client,
      gstin: ni.gstin,
      clientAddress: ni.clientAddress,
      clientPan: ni.clientPan,
      sac: ni.sac,
      lineLabel,
      lineDetail,
      taxable,
      gstPct,
      g,
      notes: ni.notes,
      qty: parseInvoiceQty(ni.qty),
    })}
</body></html>`
    if (!printHtmlDocument(html)) {
      toast_("Print failed — check browser settings or allow pop-ups", "#f43f5e")
    }
  }

  /** Print / preview a saved invoice row (list “Open” action). */
  const printSavedInvoice = inv => {
    if (!inv) return
    const g = computeInvoiceGst(inv.taxable, inv.gst_rate, inv.place)
    const taxable = Number(inv.taxable) || 0
    const split = splitStoredInvoiceDesc(inv.desc)
    const lineLabel = split.itemName || "Line item"
    const lineDetail = split.descExtra
    const gstPct = String(inv.gst_rate ?? "0")
    const place = inv.place === "inter" ? "inter" : "intra"
    const dueDate = inv.dueDate || inv.date
    const co = activeCompany
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Invoice ${escapeHtml(String(inv.num))}</title>
<style>${INVOICE_PRINT_STYLESHEET}</style></head><body>
${buildInvoicePrintDocumentHtml({
      co,
      num: inv.num,
      date: inv.date,
      dueDate,
      subtitle: inv.subtitle,
      place,
      client: inv.client,
      gstin: inv.gstin,
      clientAddress: inv.clientAddress,
      clientPan: inv.clientPan,
      sac: inv.sac,
      lineLabel,
      lineDetail,
      taxable,
      gstPct,
      g,
      notes: inv.notes,
      qty: Number(inv.qty) > 0 ? Number(inv.qty) : 1,
    })}
</body></html>`
    if (!printHtmlDocument(html)) {
      toast_("Print failed — check browser settings or allow pop-ups", "#f43f5e")
    }
  }

  const markInvoicePaidFull = useCallback(
    id => {
      if (acctRole === "Viewer") return
      const inv = invoices.find(i => i.id === id)
      if (!inv) return
      const rem = Math.round(invoiceBalance(inv) * 100) / 100
      if (rem <= 0.005) {
        toast_("Invoice already fully paid", "#f59e0b")
        return
      }
      setInvPayId(id)
      setInvPayMode("add")
      setInvPayAmt(String(rem))
      setInvPayTdsPct("")
    },
    [acctRole, invoices]
  )

  const openInvoicePaymentModal = useCallback((inv, mode = "add") => {
    if (!inv) return
    const taxable = Math.max(0, Number(inv.taxable) || 0)
    const bankNow = invoiceBankReceived(inv)
    const tdsNow = Math.max(0, Number(inv.paidTdsTotal) || 0)
    const pctNow = taxable > 0 ? Math.round((tdsNow * 10000) / taxable) / 100 : 0
    setInvPayId(inv.id)
    setInvPayMode(mode)
    setInvPayAmt(String(mode === "replace" ? bankNow : Math.max(0, invoiceBalance(inv))))
    setInvPayTdsPct(pctNow > 0 ? String(pctNow) : "")
  }, [])

  const markInvoiceUnpaid = useCallback(
    id => {
      if (acctRole === "Viewer") return
      const inv0 = invoices.find(i => i.id === id)
      if (!inv0) return
      if ((Number(inv0.paidAmount) || 0) <= 0.005 && (Number(inv0.paidTdsTotal) || 0) <= 0.005) {
        toast_("Invoice is already unpaid", "#f59e0b")
        return
      }
      const nextInv = {
        ...inv0,
        paidAmount: 0,
        paidBankTotal: 0,
        paidTdsTotal: 0,
        paidAt: "",
        status: "sent",
      }
      setInvoices(list => list.map(inv => (inv.id === id ? nextInv : inv)))
      setTxns(prev => syncLedgerWithInvoicePaymentState(prev, nextInv, { createdBy: acctRole }))
      appendAudit({ action: "INVOICE_MARK_UNPAID", invoiceId: id })
      toast_("Invoice marked unpaid · settlement entries cleared", "#f59e0b")
    },
    [acctRole, invoices, appendAudit]
  )

  const exportInvoicesCsv = (list = invoices) => {
    const header =
      "Invoice #,Date,Due Date,Client,GSTIN,SAC,Taxable,GST%,CGST,SGST,IGST,Total,Paid_settlement,Bank_received,TDS_deducted,Balance,Status,Category,Description\n"
    const body = (list || invoices)
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
    const received = parseMoneyInput(invPayAmt)
    const tdsPctRaw = parseFloat(String(invPayTdsPct).replace(/,/g, ""))
    const tdsPct = Number.isFinite(tdsPctRaw) ? Math.max(0, Math.min(99.99, tdsPctRaw)) : 0
    const taxable = Math.max(0, Number(inv0.taxable) || 0)
    const tdsFromTaxable = tdsPct > 0 ? Math.round((taxable * tdsPct) / 100 * 100) / 100 : 0
    if (received <= 0 && tdsFromTaxable <= 0) {
      toast_("Enter bank receipt (₹) or TDS % greater than zero", "#f43f5e")
      return
    }
    const tot = Number(inv0.total) || 0
    const paymentDateIso = todayISO()
    const dateDdMmYyyy = isoToDdMmYyyy(paymentDateIso)
    if (periodLockIso && isPeriodLocked(dateDdMmYyyy, periodLockIso)) {
      toast_("Date falls in a locked period — posting blocked", "#f43f5e")
      return
    }

    let nextInv = inv0
    let bankDelta = 0
    let tdsDelta = 0

    if (invPayMode === "replace") {
      const wantedSettlement = Math.round((received + tdsFromTaxable) * 100) / 100
      const finalSettlement = Math.min(Math.max(0, wantedSettlement), tot)
      let finalBank = received
      let finalTds = tdsFromTaxable
      if (wantedSettlement > finalSettlement + 0.001 && wantedSettlement > 0) {
        finalBank = Math.round((received * finalSettlement) / wantedSettlement * 100) / 100
        finalTds = Math.round((finalSettlement - finalBank) * 100) / 100
      }
      const paid = finalSettlement >= tot - 0.01
      nextInv = {
        ...inv0,
        paidAmount: finalSettlement,
        paidBankTotal: Math.max(0, finalBank),
        paidTdsTotal: Math.max(0, finalTds),
        status: finalSettlement <= 0.005 ? "sent" : paid ? "paid" : "partial",
        paidAt: finalSettlement <= 0.005 ? "" : paymentDateIso,
      }
      bankDelta = Math.round((Number(nextInv.paidBankTotal) - invoiceBankReceived(inv0)) * 100) / 100
      tdsDelta = Math.round((Number(nextInv.paidTdsTotal) - (Number(inv0.paidTdsTotal) || 0)) * 100) / 100
      setTxns(prev => syncLedgerWithInvoicePaymentState(prev, nextInv, { createdBy: acctRole }))
    } else {
      const bal = invoiceBalance(inv0)
      const pb0 = Number(inv0.paidBankTotal)
      const pt0 = Number(inv0.paidTdsTotal)
      const baseBank = Number.isFinite(pb0) ? pb0 : Number(inv0.paidAmount) || 0
      const baseTds = Number.isFinite(pt0) ? pt0 : 0
      let incBank = Math.max(0, received)
      let incTds = Math.max(0, Math.round((tdsFromTaxable - baseTds) * 100) / 100)
      let increment = Math.round((incBank + incTds) * 100) / 100
      if (increment > bal + 0.001 && increment > 0) {
        increment = Math.round(bal * 100) / 100
        incBank = Math.round((incBank * bal) / (incBank + incTds) * 100) / 100
        incTds = Math.round((increment - incBank) * 100) / 100
      }
      const capped = Math.round((Number(inv0.paidAmount) + increment) * 100) / 100
      const paid = capped >= tot - 0.01
      nextInv = {
        ...inv0,
        paidAmount: Math.min(capped, tot),
        paidBankTotal: Math.round((baseBank + incBank) * 100) / 100,
        paidTdsTotal: Math.round((baseTds + incTds) * 100) / 100,
        status: paid ? "paid" : "partial",
        paidAt: paid ? paymentDateIso : inv0.paidAt,
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
      if (res.drafts?.length) {
        const createdAt = new Date().toISOString()
        const stamped = res.drafts.map(d => ({
          ...d,
          audit: { ...d.audit, createdAt, createdBy: acctRole },
        }))
        setTxns(prev => withRecalculatedBalances(applyLedgerCategoryNormalization([...prev, ...stamped])))
      }
      bankDelta = Math.round((Number(nextInv.paidBankTotal) - baseBank) * 100) / 100
      tdsDelta = Math.round((Number(nextInv.paidTdsTotal) - baseTds) * 100) / 100
    }

    setInvoices(list => list.map(inv => (inv.id === invPayId ? nextInv : inv)))
    appendAudit({
      action: "INVOICE_PAYMENT",
      invoiceId: invPayId,
      mode: invPayMode,
      bank: bankDelta,
      tds: tdsDelta,
      tdsPct,
      settlement: bankDelta + tdsDelta,
    })
    const sumMsg =
      Math.abs(tdsDelta) > 0.005
        ? `Saved · Bank ₹${inr(bankDelta)} and TDS ₹${inr(tdsDelta)} ${invPayMode === "replace" ? "updated" : "posted"}`
        : `Saved · Bank ₹${inr(bankDelta)} ${invPayMode === "replace" ? "updated" : "posted"}`
    toast_(sumMsg, "#10b981")
    setInvPayId(null)
    setInvPayMode("add")
    setInvPayAmt("")
    setInvPayTdsPct("")
  }, [acctRole, invPayId, invPayMode, invPayAmt, invPayTdsPct, invoices, txns, periodLockIso, appendAudit])

  const filtered = useMemo(()=>{
    if(!txns) return []
    let f = showVoid ? [...ledger] : ledger.filter(t=>!t.void)
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
    if (miscRecatOnly) f = f.filter(t => t.category === "Misc Expense" || t.category === "Misc Income")
    return f
  },[txns, ledger, search, fCat, fDC, repFy, showVoid, miscRecatOnly])

  const sortedTxnRows = useMemo(() => {
    const arr = [...filtered]
    const [key, dir] = String(txnSort || "date|desc").split("|")
    const mul = dir === "asc" ? 1 : -1
    const cmpStr = (a, b) => mul * String(a ?? "").localeCompare(String(b ?? ""), undefined, { sensitivity: "base" })
    const cmpNum = (a, b) => {
      const na = Number(a)
      const nb = Number(b)
      if (Number.isNaN(na) && Number.isNaN(nb)) return 0
      if (Number.isNaN(na)) return 1 * mul
      if (Number.isNaN(nb)) return -1 * mul
      return mul * (na - nb)
    }
    arr.sort((a, b) => {
      let r = 0
      switch (key) {
        case "id":
          r = cmpNum(a.id, b.id)
          break
        case "date":
          r = mul * (parseDdMmYyyy(a.date) - parseDdMmYyyy(b.date))
          break
        case "particulars":
          r = cmpStr(a.particulars, b.particulars)
          break
        case "category":
          r = cmpStr(a.category, b.category)
          break
        case "drCr":
          r = cmpStr(a.drCr, b.drCr)
          break
        case "amount":
          r = cmpNum(a.amount, b.amount)
          break
        case "balance":
          r = cmpNum(a.balance, b.balance)
          break
        case "fy":
          r = cmpStr(a.fy, b.fy)
          break
        case "je":
          r = cmpNum(a.journalLines?.length || 0, b.journalLines?.length || 0)
          break
        default:
          r = mul * (parseDdMmYyyy(a.date) - parseDdMmYyyy(b.date))
      }
      if (r !== 0) return r
      return (Number(a.id) || 0) - (Number(b.id) || 0)
    })
    return arr
  }, [filtered, txnSort])

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

  const pages = {dash:"Dashboard",txn:"Transactions",inv:"Invoices",clients:"Clients",led:"General Ledger",coa:"Chart of Accounts",gst:"GST Compliance",pay:"Payroll & TDS",stock:"Inventory",rec:"Reconciliation",rep:"Reports & P&L",bulk:"Bulk Upload",ai:"AI Agent"}

  const overviewNavLinks = [
    ["⊞", "dash"],
    ["⇄", "txn"],
    ["≡", "inv"],
    ["🧾", "clients"],
    ["▤", "led"],
  ]
  const financeNavLinks = [
    ["◈", "gst"],
    ["⊙", "pay"],
    ["▥", "coa"],
    ["▣", "stock"],
    ["⊗", "rec"],
  ]
  const intelNavLinks = [
    ["⟂", "rep"],
    ["↑", "bulk"],
    ["✦", "ai"],
  ]

  const quickAddItems = [
    { id: "txn", icon: "⇄", title: "Transaction", sub: "Ledger · misc", fn: onQuickAddTxn },
    { id: "ven", icon: "◇", title: "Vendor payment", sub: "Debit · Vendor - Other", fn: onQuickAddVendor },
    { id: "cli", icon: "🧾", title: "Client", sub: "New client", fn: onQuickAddNewClient },
    { id: "invo", icon: "≡", title: "Invoice", sub: "Create invoice", fn: onQuickAddInvoiceOnly },
    { id: "emp", icon: "⊙", title: "Employee", sub: "Payroll record", fn: onQuickAddEmployee },
    { id: "itm", icon: "▣", title: "Inventory item", sub: "Stock line", fn: onQuickAddItem },
    { id: "co", icon: "⌂", title: "Workspace", sub: "Books & bank label", fn: onQuickAddCompany },
  ]

  const quickAddMenuGroups = [
    { key: "ledger", label: "Ledger", itemIds: ["txn", "ven"] },
    { key: "sales", label: "Sales & team", itemIds: ["cli", "invo", "emp", "itm"] },
    { key: "workspace", label: "Workspace", itemIds: ["co"] },
  ]

  const quickAddRowBase = {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    padding: "7px 10px",
    borderRadius: 8,
    cursor: "pointer",
    width: "100%",
    textAlign: "left",
    fontSize: 12,
    fontWeight: 500,
    border: "none",
    background: "transparent",
    color: "#94a3b8",
    position: "relative",
  }

  const renderQuickAddRow = item => (
    <button
      key={item.id}
      type="button"
      onClick={item.fn}
      style={quickAddRowBase}
      onMouseEnter={e => {
        e.currentTarget.style.background = JM.r(0.16)
        e.currentTarget.style.color = JM.soft
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = "transparent"
        e.currentTarget.style.color = "#94a3b8"
      }}
    >
      <span style={{ opacity: 0.6, fontSize: 12, width: 14, textAlign: "center", flexShrink: 0, lineHeight: 1.4 }}>{item.icon}</span>
      <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 1, minWidth: 0 }}>
        <span style={{ fontWeight: 600, color: "inherit" }}>{item.title}</span>
        <span style={{ fontSize: 9, color: "#64748b", fontWeight: 500, lineHeight: 1.35 }}>{item.sub}</span>
      </span>
    </button>
  )

  const navSectionToggleBtn = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    padding: "8px 7px 6px",
    letterSpacing: "1px",
    textTransform: "uppercase",
    fontWeight: 700,
    fontSize: 9,
    color: "#475569",
    border: "none",
    background: "transparent",
    cursor: "pointer",
    borderRadius: 6,
  }

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
    const bankClosingFig = periodActive ? reportStats.balance : bookBankBalance
    return (
    <div>
      {periodActive && (
        <div style={{ fontSize: 11, color: "#0369a1", marginBottom: 12, padding: "8px 11px", background: "rgba(107,122,255,.1)", borderRadius: 8, border: "1px solid rgba(107,122,255,.25)" }}>
          Period filter active — figures below are for the selected FY / month / dates. Sidebar bank balance is still your <strong>full</strong> book closing.
        </div>
      )}
      <div
        style={{
          fontSize: 11,
          color: "#475569",
          marginBottom: 14,
          padding: "12px 14px",
          background: "#ffffff",
          borderRadius: 10,
          border: "1px solid #e0f2fe",
          lineHeight: 1.55,
        }}
      >
        <div style={{ fontWeight: 800, color: "#0c4a6e", marginBottom: 8 }}>Bank balance reference (from ledger running balance)</div>
        <div>
          <strong>Last calendar month-end</strong> ({bankSnapshotHints.lastMonthEnd}):{" "}
          {bankSnapshotHints.bankAtLastMonth != null ? (
            <strong style={{ color: "#0369a1" }}>₹{inr0(bankSnapshotHints.bankAtLastMonth)}</strong>
          ) : (
            <span style={{ color: "#94a3b8" }}>— (no transactions through that date yet)</span>
          )}
        </div>
        {repFy ? (
          <div style={{ marginTop: 6 }}>
            <strong>End of previous FY</strong> ({bankSnapshotHints.fyEnd}, day before {formatFyLabel(repFy)}):{" "}
            {bankSnapshotHints.bankAtFyOpen != null ? (
              <strong style={{ color: "#0c4a6e" }}>₹{inr0(bankSnapshotHints.bankAtFyOpen)}</strong>
            ) : (
              <span style={{ color: "#94a3b8" }}>— (no rows on/before that date — post opening or import history)</span>
            )}
          </div>
        ) : (
          <div style={{ marginTop: 6, fontSize: 10, color: "#64748b" }}>
            Select a <strong>Financial year</strong> in the header to see the bank figure at <strong>31 March</strong> before that FY (e.g. ₹21,840 on 31 Mar 2025 before FY 2025-26).
          </div>
        )}
        <div style={{ fontSize: 10, color: "#64748b", marginTop: 10, paddingTop: 10, borderTop: "1px dashed #bae6fd" }}>
          <strong>New FY from 1 Apr?</strong> If books start fresh but cash was ₹21,840 on 31 Mar, add one line dated{" "}
          <strong>01/04/…</strong>: <strong>Credit</strong> that amount, narration e.g. &quot;Opening balance b/f 31 Mar&quot;, category{" "}
          <strong>Capital Infusion - Cash</strong> (or your CA&apos;s mapping). That seeds the running balance; or keep importing bank CSV so the
          balance column chains correctly.
        </div>
      </div>
      <div style={S.g4}>
        <Stat label="Total receipts (CR)" value={"₹"+inr0(reportStats.cr)} sub={periodActive?"Filtered period":"All dates in book"} color="#10b981" icon="💰"/>
        <Stat label="Total payments (DR)" value={"₹"+inr0(reportStats.dr)} sub={periodActive?"Filtered period":"All dates in book"} color="#f43f5e" icon="📤"/>
        <Stat
          label="Booked CR − DR"
          value={"₹" + inr0(reportStats.flowNet)}
          sub={
            !periodActive
              ? "Bank lines only — same net as Bank closing (full book)"
              : "Σ (credits − debits) on bank lines only"
          }
          color="#6B7AFF"
          icon="📈"
        />
        <Stat label="Transactions" value={String(reportStats.count)} sub={"In scope · CR:"+crN+" · DR:"+drN} icon="⇄"/>
      </div>
      <div style={S.g3}>
        <Stat label="Top revenue category" value={topName} sub={topRev ? "₹"+inr0(topAmt)+" · "+topPct+"% of Revenue-* credits" : "Add Revenue-* credits"} color="#5563E8" icon="🤝"/>
        <Stat
          label={periodActive ? "Period closing (bank col.)" : "Bank closing (full book)"}
          value={"₹" + inr0(bankClosingFig)}
          sub={
            periodActive
              ? (activeCompany?.bankAccountLabel?.slice(0, 36) || "Primary bank") +
                " · last row in period (imported balance column)"
              : (activeCompany?.bankAccountLabel?.slice(0, 36) || "Primary bank") +
                " · journal net (Dr−Cr) — matches Chart of Accounts"
          }
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
          <Tbl cols={[{h:"Date",k:"date"},{h:"Particulars",cell:r=><span style={{fontSize:11,color:"#94a3b8",opacity:r.void?0.45:1}}>{r.particulars.substring(0,34)}{r.void?" (void)":""}</span>},{h:"Category",cell:r=><Chip cat={r.category}/>},{h:"Amount",r:true,cell:r=><span style={{color:r.drCr==="CR"?"#10b981":"#f43f5e",fontFamily:"monospace",fontWeight:700,fontSize:11,opacity:r.void?.5:1}}>{r.drCr==="CR"?"+":"-"}₹{inr(r.amount)}</span>}]} rows={ledger.filter(t=>!t.void).slice(-6).reverse()}/>
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
        {miscRecatOnly ? (
          <div
            style={{
              fontSize: 11,
              color: "#0369a1",
              marginBottom: 10,
              padding: "8px 12px",
              background: "rgba(16,185,129,.08)",
              border: "1px solid rgba(16,185,129,.25)",
              borderRadius: 8,
              lineHeight: 1.5,
            }}
          >
            Showing <strong>Misc Expense</strong> and <strong>Misc Income</strong> only. Use the <strong>Category</strong> dropdown on each row to set the correct ledger — journal lines update automatically (Dr/Cr stays the same).
          </div>
        ) : null}
        <div style={{display:"flex",gap:7,flexWrap:"wrap",alignItems:"center",marginBottom:13}}>
          <label style={{fontSize:11,color:"#94a3b8",display:"flex",alignItems:"center",gap:6}}><input type="checkbox" checked={showVoid} onChange={e=>setShowVoid(e.target.checked)}/> Show voided</label>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="🔍 Search..." style={{...IS,width:200,height:32}}/>
          <select value={fDC} onChange={e=>setFDC(e.target.value)} style={{...S.sel,width:110}}><option value="">All Types</option><option value="CR">Credits</option><option value="DR">Debits</option></select>
          <select value={fCat} onChange={e=>setFCat(e.target.value)} style={{...S.sel,width:170}}><option value="">All Categories</option>{CATS.map(c=><option key={c} value={c}>{c}</option>)}</select>
          <select
            value={txnSort}
            onChange={e => setTxnSort(e.target.value)}
            title="Sort transactions"
            style={{ ...S.sel, width: 200 }}
          >
            <option value="date|desc">Sort: Date · newest</option>
            <option value="date|asc">Sort: Date · oldest</option>
            <option value="id|asc">Sort: # · low → high</option>
            <option value="id|desc">Sort: # · high → low</option>
            <option value="particulars|asc">Sort: Particulars · A→Z</option>
            <option value="particulars|desc">Sort: Particulars · Z→A</option>
            <option value="category|asc">Sort: Category · A→Z</option>
            <option value="category|desc">Sort: Category · Z→A</option>
            <option value="drCr|asc">Sort: Type · CR then DR</option>
            <option value="drCr|desc">Sort: Type · DR then CR</option>
            <option value="amount|asc">Sort: Amount · low → high</option>
            <option value="amount|desc">Sort: Amount · high → low</option>
            <option value="balance|asc">Sort: Balance · low → high</option>
            <option value="balance|desc">Sort: Balance · high → low</option>
            <option value="fy|asc">Sort: FY · A→Z</option>
            <option value="fy|desc">Sort: FY · Z→A</option>
            <option value="je|asc">Sort: JE · few lines first</option>
            <option value="je|desc">Sort: JE · many lines first</option>
          </select>
          <button
            type="button"
            onClick={() => {
              setMiscRecatOnly(v => {
                if (!v) setFCat("")
                return !v
              })
            }}
            title="Show only Misc Expense & Misc Income — use the dropdown in Category to fix bank guesses"
            style={{
              ...S.btnO,
              fontSize: 11,
              padding: "5px 11px",
              borderColor: miscRecatOnly ? JM.r(0.45) : SKY.borderHi,
              color: miscRecatOnly ? JM.soft : SKY.text2,
              fontWeight: miscRecatOnly ? 700 : 600,
            }}
          >
            {miscRecatOnly ? "✓ Misc only (fix category)" : "Misc only (fix category)"}
          </button>
          <button
            type="button"
            onClick={() => {
              setNt({
                date: todayISO(),
                particulars: pickSuggestedParticulars(txns, "Misc Expense", "Debit"),
                amount: "",
                drCr: "Debit",
                category: "Misc Expense",
                ref: "",
              })
              setModal("txn")
            }}
            disabled={acctRole === "Viewer"}
            style={{
              ...S.btn,
              fontSize: 11,
              padding: "5px 11px",
              opacity: acctRole === "Viewer" ? 0.45 : 1,
              cursor: acctRole === "Viewer" ? "default" : "pointer",
            }}
          >
            {acctRole === "Viewer" ? "View-only" : "+ Add"}
          </button>
          <button type="button" onClick={()=>{const h="Date,Particulars,Category,Type,Amount,Balance,FY\n"+txns.map(t=>[t.date,'"'+t.particulars.replace(/"/g,"'")+'"',t.category,t.drCr,t.amount,t.balance,t.fy].join(",")).join("\n");const b=new Blob([h],{type:"text/csv"});const a=document.createElement("a");a.href=URL.createObjectURL(b);a.download="jm_tally_txns.csv";a.click()}} style={{...S.btnO,fontSize:11,padding:"5px 11px"}}>⬇ CSV</button>
        </div>
        <Tbl cols={[
          {h:"#",k:"id",cell:r=><span style={{color:"#475569",fontSize:11}}>{r.id}</span>},
          {h:"Date",k:"date"},
          {h:"Particulars",cell:r=><span style={{fontSize:11,opacity:r.void?0.55:1}} title={r.void?(r.voidReason?`${r.particulars}\n\nVoid reason: ${r.voidReason}`:r.particulars):r.particulars}>{r.particulars.substring(0,46)}{r.void?" (void)":""}</span>},
          {h:"Category",cell:r=>{
            const misc = (r.category === "Misc Expense" || r.category === "Misc Income") && !r.void
            if (misc && acctRole !== "Viewer") {
              return (
                <select
                  value={r.category}
                  onChange={e => updateTxnCategoryFromMisc(r.id, e.target.value)}
                  style={{
                    fontSize: 10,
                    maxWidth: 200,
                    padding: "4px 6px",
                    borderRadius: 6,
                    border: `1px solid ${SKY.borderHi}`,
                    background: SKY.surface,
                    color: SKY.text,
                    fontFamily: "inherit",
                    cursor: "pointer",
                  }}
                  title="Correct category (was misc)"
                >
                  {CATS.map(c => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              )
            }
            return <Chip cat={r.category} />
          }},
          {h:"Type",cell:r=><span style={{...pillStyle(r.drCr==="CR"?"Revenue":"Director Payment",r.drCr),fontSize:9.5}}>{r.drCr}</span>},
          {h:"Amount",r:true,cell:r=><span style={{color:r.drCr==="CR"?"#10b981":"#f43f5e",fontFamily:"monospace",fontWeight:700}}>{r.drCr==="CR"?"+":"-"}₹{inr(r.amount)}</span>},
          {h:"Balance",r:true,cell:r=><span style={{color:"#6B7AFF",fontFamily:"monospace"}}>₹{inr(r.balance)}</span>},
          {h:"FY",cell:r=><Chip cat="Bank Charges" label={r.fy}/>},
          {h:"JE",cell:r=><span style={{fontSize:10,color:r.journalLines?"#10b981":"#64748b"}} title={r.journalLines?r.journalLines.map(l=>`${l.account} Dr ${l.debit||""} Cr ${l.credit||""}`).join(" · "):""}>{r.journalLines?r.journalLines.length+"L ✓":"—"}</span>},
          {h:"",cell:r=><button title="Void (no hard delete)" disabled={acctRole==="Viewer"||r.void} onClick={()=>openVoidConfirm(r.id)} style={{background:"none",border:"none",cursor:r.void||acctRole==="Viewer"?"default":"pointer",color:r.void?"#475569":"#f59e0b",fontSize:12,padding:"2px 5px"}}>{r.void?"✕":"⊘"}</button>},
        ]} rows={sortedTxnRows} empty="No transactions match filters"/>
      </div>
    )
  }

  const Inv = () => {
    const [invPrimaryTab, setInvPrimaryTab] = useState("sales")
    const [invDatePreset, setInvDatePreset] = useState("lifetime")
    const [invFilterFrom, setInvFilterFrom] = useState("")
    const [invFilterTo, setInvFilterTo] = useState("")
    const [invFilterClient, setInvFilterClient] = useState("")
    const [invClientSelectKey, setInvClientSelectKey] = useState("")
    const [invFiltersOpen, setInvFiltersOpen] = useState(false)
    const [invOvSummaryOpen, setInvOvSummaryOpen] = useState(false)
    const [invOvGraphOpen, setInvOvGraphOpen] = useState(false)
    const [invSalesSummaryOpen, setInvSalesSummaryOpen] = useState(true)
    const [invSalesGraphOpen, setInvSalesGraphOpen] = useState(false)
    const [invGraphGranularity, setInvGraphGranularity] = useState("monthly")
    const [invGraphType, setInvGraphType] = useState("line")
    const [invGraphStartIdx, setInvGraphStartIdx] = useState(0)
    const [invTablePage, setInvTablePage] = useState(1)
    const [invPageSize, setInvPageSize] = useState(50)
    const [invExpandedIds, setInvExpandedIds] = useState(() => new Set())
    const [invSelectedIds, setInvSelectedIds] = useState(() => new Set())
    const [invColVis, setInvColVis] = useState({
      idx: true,
      expand: true,
      date: true,
      invoice: true,
      billedTo: true,
      amount: true,
      status: true,
      nextSched: true,
      payDate: true,
    })
    const [invColMenuOpen, setInvColMenuOpen] = useState(false)
    const [invMoreMenuId, setInvMoreMenuId] = useState(null)
    const [shareEarnInvHidden, setShareEarnInvHidden] = useState(() => {
      try {
        return localStorage.getItem("jm_hide_share_earn_inv") === "1"
      } catch {
        return false
      }
    })
    const invListHeaderCbRef = useRef(null)

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

    const filteredInvList = useMemo(() => {
      let list = [...invoices]
      list = list.filter(inv => {
        const u = invoiceUiStatus(inv)
        if (invListFilter === "all") return true
        if (invListFilter === "paid") return u === "paid"
        if (invListFilter === "overdue") return u === "overdue"
        if (invListFilter === "open") return u !== "paid"
        return true
      })
      if (invClientSelectKey) {
        const row = invoiceClientPresets.find(p => p.key === invClientSelectKey)
        if (row) {
          list = list.filter(inv => {
            const n = String(inv.client || "")
              .trim()
              .toLowerCase()
            const g = String(inv.gstin || "")
              .trim()
              .toUpperCase()
            return n === String(row.client || "")
              .trim()
              .toLowerCase() && g === String(row.gstin || "").trim().toUpperCase()
          })
        }
      }
      if (invFilterClient.trim()) {
        const q = invFilterClient.trim().toLowerCase()
        list = list.filter(inv => String(inv.client).toLowerCase().includes(q))
      }
      if (invDatePreset === "custom" && (invFilterFrom || invFilterTo)) {
        const from = invFilterFrom ? Date.parse(`${invFilterFrom}T00:00:00`) : -Infinity
        const to = invFilterTo ? Date.parse(`${invFilterTo}T23:59:59`) : Infinity
        list = list.filter(inv => {
          const t = Date.parse(inv.date)
          return Number.isFinite(t) && t >= from && t <= to
        })
      }
      return list.sort((a, b) => new Date(b.date) - new Date(a.date) || b.id - a.id)
    }, [invoices, invListFilter, invClientSelectKey, invFilterClient, invDatePreset, invFilterFrom, invFilterTo, invoiceClientPresets])

    const invMetrics = useMemo(() => {
      const list = filteredInvList
      const n = list.length
      const totalAmt = list.reduce((s, x) => s + (Number(x.total) || 0), 0)
      const dueAmt = list.reduce((s, x) => s + Math.max(0, invoiceBalance(x)), 0)
      const paidAmt = list.reduce((s, x) => s + invoiceBankReceived(x), 0)
      const gstAmt = list.reduce((s, x) => s + (Number(x.cgst) || 0) + (Number(x.sgst) || 0) + (Number(x.igst) || 0), 0)
      const tdsAmt = list.reduce((s, x) => s + (Number(x.paidTdsTotal) || 0), 0)
      return { n, totalAmt, dueAmt, paidAmt, gstAmt, tdsAmt }
    }, [filteredInvList])

    const invGraphSeries = useMemo(() => {
      const list = filteredInvList
      const invoicedMap = new Map()
      const paidMap = new Map()
      const keyOf = iso => {
        if (!iso) return null
        const d = new Date(iso)
        if (!Number.isFinite(d.getTime())) return null
        const y = d.getFullYear()
        const m = d.getMonth()
        if (invGraphGranularity === "quarterly") {
          const q = Math.floor(m / 3) + 1
          return `${y}-Q${q}`
        }
        return `${y}-${String(m + 1).padStart(2, "0")}`
      }
      for (const inv of list) {
        const mk = keyOf(inv.date)
        if (mk) invoicedMap.set(mk, (invoicedMap.get(mk) || 0) + (Number(inv.total) || 0))
        const paid = invoiceBankReceived(inv)
        if (paid > 0.005) {
          const pk = keyOf(inv.paidAt || inv.date)
          if (pk) paidMap.set(pk, (paidMap.get(pk) || 0) + paid)
        }
      }
      const keys = [...new Set([...invoicedMap.keys(), ...paidMap.keys()])].sort()
      return keys.map(k => ({ k, inv: invoicedMap.get(k) || 0, pay: paidMap.get(k) || 0 }))
    }, [filteredInvList, invGraphGranularity])

    const invChartByMonth = useMemo(() => {
      const map = new Map()
      for (const inv of invoices) {
        const d = inv.date
        if (!d || String(d).length < 7) continue
        const m = String(d).slice(0, 7)
        map.set(m, (map.get(m) || 0) + (Number(inv.total) || 0))
      }
      return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-8)
    }, [invoices])

    const invTotalPages = Math.max(1, Math.ceil(filteredInvList.length / invPageSize))
    const paginatedInv = useMemo(() => {
      const start = (invTablePage - 1) * invPageSize
      return filteredInvList.slice(start, start + invPageSize)
    }, [filteredInvList, invTablePage, invPageSize])

    useEffect(() => {
      setInvTablePage(1)
    }, [invListFilter, invClientSelectKey, invFilterClient, invDatePreset, invFilterFrom, invFilterTo, invPageSize])

    useEffect(() => {
      setInvGraphStartIdx(0)
    }, [invGraphSeries.length, invGraphGranularity, filteredInvList.length])

    const clearInvFilters = () => {
      setInvClientSelectKey("")
      setInvFilterClient("")
      setInvFilterFrom("")
      setInvFilterTo("")
      setInvDatePreset("lifetime")
      setInvListFilter("all")
    }

    const invGraphMaxVis = 10
    const invGraphSlice = useMemo(() => {
      if (!invGraphSeries.length) return []
      const maxStart = Math.max(0, invGraphSeries.length - invGraphMaxVis)
      const start = Math.min(invGraphStartIdx, maxStart)
      return invGraphSeries.slice(start, start + invGraphMaxVis)
    }, [invGraphSeries, invGraphStartIdx])

    const maxChart = Math.max(1, ...invChartByMonth.map(([, v]) => v))

    const invListColSpan = useMemo(() => {
      let n = 1
      if (invColVis.idx) n++
      if (invColVis.expand) n++
      if (invColVis.date) n++
      if (invColVis.invoice) n++
      if (invColVis.billedTo) n++
      if (invColVis.amount) n++
      if (invColVis.status) n++
      if (invColVis.nextSched) n++
      if (invColVis.payDate) n++
      n++
      return n
    }, [invColVis])

    const allInvPageSelected = paginatedInv.length > 0 && paginatedInv.every(r => invSelectedIds.has(r.id))
    const someInvPageSelected = paginatedInv.some(r => invSelectedIds.has(r.id))

    useEffect(() => {
      const el = invListHeaderCbRef.current
      if (el) el.indeterminate = someInvPageSelected && !allInvPageSelected
    }, [someInvPageSelected, allInvPageSelected, paginatedInv])

    const invTabBtn = k => S.tab(invPrimaryTab === k)
    const invStatusLabels = { all: "All", open: "Open", overdue: "Overdue", paid: "Paid" }
    const chipX = {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      fontSize: 10,
      fontWeight: 600,
      padding: "4px 10px",
      borderRadius: 999,
      background: JM.r(0.1),
      border: `1px solid ${JM.r(0.22)}`,
      color: "#0c4a6e",
    }
    return (
      <div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4 }}>
              <span style={{ fontWeight: 700, color: "#0c4a6e" }}>{activeCompany?.name || "Company"}</span>
              <span style={{ margin: "0 8px", opacity: 0.45 }}>›</span>
              <span>Invoices</span>
            </div>
            <div style={{ fontSize: 10, color: "#94a3b8" }}>Sales register · bank receipts · client balances</div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button
              type="button"
              onClick={() => toast_("Scan to invoice — use Bulk Upload for bank PDFs, or paste details in Create invoice.", "#0369a1")}
              style={{ ...S.btnO, fontSize: 11, padding: "6px 12px" }}
            >
              Scan invoice
            </button>
            <button type="button" onClick={openCreateInvoiceModal} disabled={acctRole === "Viewer"} style={{ ...S.btn, fontSize: 12, padding: "7px 14px", opacity: acctRole === "Viewer" ? 0.45 : 1 }}>
              + Create invoice
            </button>
          </div>
        </div>

        <div style={S.tabs}>
          {[
            ["overview", "Overview"],
            ["sales", "Sales register"],
            ["bank", "Bank credits"],
          ].map(([k, l]) => (
            <button key={k} type="button" onClick={() => setInvPrimaryTab(k)} style={invTabBtn(k)}>
              {l}
            </button>
          ))}
        </div>

        {invPrimaryTab === "overview" ? (
          <>
        <div style={S.g4}>
              <Stat label="Outstanding (invoices)" value={"₹" + inr0(outstand)} sub={String(invoices.length) + " issued"} color="#f59e0b" />
              <Stat label="Overdue" value={String(overdueN)} sub="Past due date & unpaid" color={overdueN ? "#f43f5e" : "#94a3b8"} />
              <Stat label="GST on open balance (est.)" value={"₹" + inr0(gstOpen)} sub="CGST+SGST or IGST" color="#5563E8" />
              <Stat label="Fully paid" value={String(paidN)} sub="Invoices settled" color="#10b981" />
            </div>
            <button
              type="button"
              onClick={() => setInvOvSummaryOpen(o => !o)}
              style={{ ...navSectionToggleBtn, width: "100%", marginBottom: invOvSummaryOpen ? 8 : 0 }}
            >
              <span>Invoice summary</span>
              <span style={{ fontSize: 10, opacity: 0.65 }}>{invOvSummaryOpen ? "▼" : "▶"}</span>
            </button>
            {invOvSummaryOpen ? (
              <div style={{ ...S.card, marginBottom: 13, fontSize: 11, color: "#475569", lineHeight: 1.65 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
                  <div>
                    <strong style={{ color: "#0c4a6e" }}>Totals</strong>
                    <div>Invoice value (lifetime): ₹{inr0(invoices.reduce((s, i) => s + (Number(i.total) || 0), 0))}</div>
                    <div>Collected (bank): ₹{inr0(invoices.reduce((s, i) => s + invoiceBankReceived(i), 0))}</div>
                  </div>
                  <div>
                    <strong style={{ color: "#0c4a6e" }}>Open pipeline</strong>
                    <div>Still due: ₹{inr0(outstand)}</div>
                    <div>Clients with open AR: {new Set(invoices.filter(i => invoiceBalance(i) > 0.01).map(i => String(i.client).toLowerCase())).size}</div>
                  </div>
                </div>
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => setInvOvGraphOpen(o => !o)}
              style={{ ...navSectionToggleBtn, width: "100%", marginBottom: invOvGraphOpen ? 10 : 0 }}
            >
              <span>Invoice graph (by month)</span>
              <span style={{ fontSize: 10, opacity: 0.65 }}>{invOvGraphOpen ? "▼" : "▶"}</span>
            </button>
            {invOvGraphOpen ? (
              <div style={{ ...S.card, marginBottom: 16 }}>
                {invChartByMonth.length ? (
                  <div style={{ display: "flex", gap: 6, alignItems: "flex-end", height: 120, paddingTop: 8 }}>
                    {invChartByMonth.map(([m, v]) => (
                      <div key={m} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                        <div
                          style={{
                            width: "100%",
                            maxWidth: 48,
                            height: Math.max(4, Math.round((v / maxChart) * 88)),
                            background: `linear-gradient(180deg, ${JM.p}, ${JM.r(0.45)})`,
                            borderRadius: "6px 6px 0 0",
                          }}
                          title={"₹" + inr0(v)}
                        />
                        <div style={{ fontSize: 9, color: "#64748b", textAlign: "center" }}>{m.slice(5)}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 11, color: "#94a3b8" }}>No invoice history yet — create a sales invoice to see trends.</div>
                )}
              </div>
            ) : null}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" onClick={() => setInvPrimaryTab("sales")} style={{ ...S.btn, fontSize: 11, padding: "6px 12px" }}>
                Open sales register →
              </button>
              <button type="button" onClick={() => setPage("clients")} style={{ ...S.btnO, fontSize: 11, padding: "6px 12px" }}>
                Manage clients
              </button>
            </div>
          </>
        ) : null}

        {invPrimaryTab === "sales" ? (
          <>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
              <button
                type="button"
                onClick={() => setInvFiltersOpen(o => !o)}
                style={{ ...navSectionToggleBtn, flex: "1 1 200px", marginBottom: 0 }}
              >
                <span style={{ fontWeight: 800 }}>Filters</span>
                <span style={{ fontSize: 10, opacity: 0.65 }}>{invFiltersOpen ? "▼" : "▶"}</span>
              </button>
              <button type="button" onClick={clearInvFilters} style={{ ...S.btnO, fontSize: 11, padding: "7px 14px" }}>
                Clear all filters
              </button>
            </div>
            {invFiltersOpen ? (
              <div style={{ ...S.card, marginBottom: 12 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 14, alignItems: "end" }}>
                  <div>
                    <div style={{ fontSize: 9, fontWeight: 700, color: "#64748b", marginBottom: 5, letterSpacing: "0.06em" }}>SELECT INVOICE STATUS</div>
                    <select value={invListFilter} onChange={e => setInvListFilter(e.target.value)} style={{ ...hdrInput, width: "100%", cursor: "pointer" }}>
                      <option value="all">{invStatusLabels.all}</option>
                      <option value="open">{invStatusLabels.open}</option>
                      <option value="overdue">{invStatusLabels.overdue}</option>
                      <option value="paid">{invStatusLabels.paid}</option>
                    </select>
                  </div>
                  <div>
                    <div style={{ fontSize: 9, fontWeight: 700, color: "#64748b", marginBottom: 5, letterSpacing: "0.06em" }}>SEARCH CLIENT</div>
                    <select value={invClientSelectKey} onChange={e => setInvClientSelectKey(e.target.value)} style={{ ...hdrInput, width: "100%", cursor: "pointer" }}>
                      <option value="">All clients</option>
                      {invoiceClientPresets.map(p => (
                        <option key={p.key} value={p.key}>
                          {p.client}
                          {p.gstin ? ` · ${p.gstin}` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <div style={{ fontSize: 9, fontWeight: 700, color: "#64748b", marginBottom: 5, letterSpacing: "0.06em" }}>NARROW BY NAME</div>
                    <input
                      type="search"
                      value={invFilterClient}
                      onChange={e => setInvFilterClient(e.target.value)}
                      placeholder="Contains text…"
                      style={{ ...hdrInput, width: "100%" }}
                    />
                  </div>
                  <div>
                    <div style={{ fontSize: 9, fontWeight: 700, color: "#64748b", marginBottom: 5, letterSpacing: "0.06em" }}>DATE RANGE</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                      <select value={invDatePreset} onChange={e => setInvDatePreset(e.target.value)} style={{ ...hdrInput, width: 120, cursor: "pointer" }}>
                        <option value="lifetime">Lifetime</option>
                        <option value="custom">Custom</option>
                      </select>
                      {invDatePreset === "custom" ? (
                        <>
                          <input type="date" value={invFilterFrom} onChange={e => setInvFilterFrom(e.target.value)} style={{ ...hdrInput, width: 132 }} />
                          <span style={{ fontSize: 11, color: "#94a3b8" }}>to</span>
                          <input type="date" value={invFilterTo} onChange={e => setInvFilterTo(e.target.value)} style={{ ...hdrInput, width: 132 }} />
                        </>
                      ) : null}
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: 9, fontWeight: 700, color: "#64748b", marginTop: 14, marginBottom: 6, letterSpacing: "0.06em" }}>APPLIED FILTERS</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", minHeight: 28 }}>
                  {invListFilter !== "all" ? (
                    <span style={chipX}>
                      Status: {invStatusLabels[invListFilter] || invListFilter}
                      <button type="button" onClick={() => setInvListFilter("all")} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0, color: "#64748b" }} aria-label="Remove status filter">
                        ×
                      </button>
                    </span>
                  ) : null}
                  {invListFilter === "all" && !invClientSelectKey && !invFilterClient.trim() && !(invDatePreset === "custom" && (invFilterFrom || invFilterTo)) ? (
                    <span style={{ fontSize: 11, color: "#94a3b8" }}>Showing all invoices (paid, overdue, open). Use status or other filters above to narrow.</span>
                  ) : null}
                  {invClientSelectKey ? (
                    <span style={chipX}>
                      Client: {invoiceClientPresets.find(p => p.key === invClientSelectKey)?.client || "—"}
                      <button type="button" onClick={() => setInvClientSelectKey("")} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0, color: "#64748b" }} aria-label="Remove client filter">
                        ×
                      </button>
                    </span>
                  ) : null}
                  {invFilterClient.trim() ? (
                    <span style={chipX}>
                      Search: “{invFilterClient.trim()}”
                      <button type="button" onClick={() => setInvFilterClient("")} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0, color: "#64748b" }} aria-label="Clear search">
                        ×
                      </button>
                    </span>
                  ) : null}
                  {invDatePreset === "custom" && (invFilterFrom || invFilterTo) ? (
                    <span style={chipX}>
                      Dates: {invFilterFrom || "…"} → {invFilterTo || "…"}
                      <button
                        type="button"
                        onClick={() => {
                          setInvDatePreset("lifetime")
                          setInvFilterFrom("")
                          setInvFilterTo("")
                        }}
                        style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0, color: "#64748b" }}
                        aria-label="Remove date filter"
                      >
                        ×
                      </button>
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}

            <button
              type="button"
              onClick={() => setInvSalesSummaryOpen(o => !o)}
              style={{ ...navSectionToggleBtn, width: "100%", marginBottom: invSalesSummaryOpen ? 10 : 0 }}
            >
              <span style={{ fontWeight: 800 }}>Invoice summary</span>
              <span style={{ fontSize: 10, opacity: 0.65 }}>{invSalesSummaryOpen ? "▼" : "▶"}</span>
            </button>
            {invSalesSummaryOpen ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 11, marginBottom: 14 }}>
                <Stat label="Invoices" value={String(invMetrics.n)} sub="In current filter" color="#0369a1" icon="📄" />
                <Stat label="Total amount" value={"₹" + inr0(invMetrics.totalAmt)} sub="Sum of invoice totals" color="#0c4a6e" icon="₹" />
                <Stat label="Amount due" value={"₹" + inr0(invMetrics.dueAmt)} sub="Outstanding balance" color="#f59e0b" icon="⏳" />
                <Stat label="Payment received" value={"₹" + inr0(invMetrics.paidAmt)} sub="Credited in bank" color="#10b981" icon="✓" />
                <Stat label="GST amount" value={"₹" + inr0(invMetrics.gstAmt)} sub="CGST+SGST+IGST on list" color="#5563E8" icon="◎" />
                <Stat label="TDS" value={"₹" + inr0(invMetrics.tdsAmt)} sub="Withheld (recorded)" color="#0369a1" icon="⊡" />
              </div>
            ) : null}

            <button
              type="button"
              onClick={() => setInvSalesGraphOpen(o => !o)}
              style={{ ...navSectionToggleBtn, width: "100%", marginBottom: invSalesGraphOpen ? 10 : 0 }}
            >
              <span style={{ fontWeight: 800 }}>Invoice graph</span>
              <span style={{ fontSize: 10, opacity: 0.65 }}>{invSalesGraphOpen ? "▼" : "▶"}</span>
            </button>
            {invSalesGraphOpen ? (
              <div style={{ ...S.card, marginBottom: 14 }}>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: 10, marginBottom: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: "#64748b" }}>VIEW</span>
                    <select value={invGraphGranularity} onChange={e => setInvGraphGranularity(e.target.value)} style={{ ...hdrInput, width: 120, cursor: "pointer" }}>
                      <option value="monthly">Monthly</option>
                      <option value="quarterly">Quarterly</option>
                    </select>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: "#64748b" }}>CHART</span>
                    <select value={invGraphType} onChange={e => setInvGraphType(e.target.value)} style={{ ...hdrInput, width: 120, cursor: "pointer" }}>
                      <option value="line">Line chart</option>
                      <option value="bar">Bar chart</option>
                    </select>
                  </div>
                </div>
                {invGraphSlice.length ? (
                  (() => {
                    const gw = 720
                    const gh = 200
                    const pad = { l: 48, r: 16, t: 12, b: 40 }
                    const data = invGraphSlice
                    const maxY = Math.max(1, ...data.flatMap(d => [d.inv, d.pay]))
                    const n = Math.max(1, data.length - 1)
                    const sx = i => (data.length <= 1 ? (gw + pad.l - pad.r) / 2 : pad.l + (i / n) * (gw - pad.l - pad.r))
                    const sy = v => pad.t + (1 - v / maxY) * (gh - pad.t - pad.b)
                    const pathInv = data.map((d, i) => `${i === 0 ? "M" : "L"} ${sx(i)} ${sy(d.inv)}`).join(" ")
                    const pathPay = data.map((d, i) => `${i === 0 ? "M" : "L"} ${sx(i)} ${sy(d.pay)}`).join(" ")
                    const barW = Math.min(28, (gw - pad.l - pad.r) / (data.length * 2.5))
                    return (
                      <div style={{ overflowX: "auto" }}>
                        <svg width={gw} height={gh} style={{ display: "block", maxWidth: "100%" }} viewBox={`0 0 ${gw} ${gh}`}>
                          <line x1={pad.l} y1={gh - pad.b} x2={gw - pad.r} y2={gh - pad.b} stroke="#e2e8f0" strokeWidth={1} />
                          <text x={pad.l - 4} y={pad.t + 4} fontSize={9} fill="#94a3b8" textAnchor="end">
                            ₹{inr0(maxY)}
                          </text>
                          <text x={pad.l - 4} y={gh - pad.b} fontSize={9} fill="#94a3b8" textAnchor="end">
                            ₹0
                          </text>
                          {invGraphType === "line" ? (
                            <>
                              <path d={pathInv} fill="none" stroke="#2563eb" strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
                              <path d={pathPay} fill="none" stroke="#10b981" strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
                              {data.map((d, i) => (
                                <g key={d.k}>
                                  <circle cx={sx(i)} cy={sy(d.inv)} r={3.5} fill="#2563eb" />
                                  <circle cx={sx(i)} cy={sy(d.pay)} r={3.5} fill="#10b981" />
                                </g>
                              ))}
                            </>
                          ) : (
                            data.map((d, i) => {
                              const cx = sx(i)
                              return (
                                <g key={d.k}>
                                  <rect x={cx - barW - 2} y={sy(d.inv)} width={barW} height={gh - pad.b - sy(d.inv)} fill="rgba(37,99,235,.75)" rx={3} />
                                  <rect x={cx + 2} y={sy(d.pay)} width={barW} height={gh - pad.b - sy(d.pay)} fill="rgba(16,185,129,.75)" rx={3} />
                                </g>
                              )
                            })
                          )}
                          {data.map((d, i) => (
                            <text key={d.k} x={sx(i)} y={gh - 10} fontSize={8} fill="#64748b" textAnchor="middle">
                              {d.k.length > 7 ? d.k.replace(/^(\d{4})-(\d{2})/, "$2/") : d.k}
                            </text>
                          ))}
                        </svg>
                        {invGraphSeries.length > invGraphMaxVis ? (
                          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, paddingLeft: 4 }}>
                            <span style={{ fontSize: 10, color: "#64748b" }}>Period</span>
                            <input
                              type="range"
                              min={0}
                              max={Math.max(0, invGraphSeries.length - invGraphMaxVis)}
                              value={Math.min(invGraphStartIdx, Math.max(0, invGraphSeries.length - invGraphMaxVis))}
                              onChange={e => setInvGraphStartIdx(Number(e.target.value))}
                              style={{ flex: 1, maxWidth: 360, accentColor: JM.p }}
                            />
                          </div>
                        ) : null}
                        <div style={{ display: "flex", justifyContent: "center", gap: 20, marginTop: 10, fontSize: 10, fontWeight: 600, color: "#475569" }}>
                          <span>
                            <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 999, background: "#2563eb", marginRight: 6, verticalAlign: "middle" }} />
                            Invoiced amount
                          </span>
                          <span>
                            <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 999, background: "#10b981", marginRight: 6, verticalAlign: "middle" }} />
                            Payment received
                          </span>
                        </div>
                      </div>
                    )
                  })()
                ) : (
                  <div style={{ fontSize: 11, color: "#94a3b8", padding: "12px 0" }}>No data for this filter — widen filters or add invoices.</div>
                )}
              </div>
            ) : null}

            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: 8, marginBottom: 8 }}>
              <button type="button" onClick={() => exportInvoicesCsv(filteredInvList)} disabled={!filteredInvList.length} style={{ ...S.btnO, fontSize: 11, padding: "5px 11px", opacity: filteredInvList.length ? 1 : 0.45 }}>
                ⬇ Download CSV
              </button>
            </div>

            <div style={{ background: "rgba(107,122,255,.08)", border: "1px solid rgba(107,122,255,.22)", borderRadius: 10, padding: "10px 14px", marginBottom: 13, fontSize: 11, color: "#0369a1", lineHeight: 1.55 }}>
              <strong>Sales register</strong> — Taxable + GST (intra-state CGST+SGST or inter-state IGST). <strong>Pay…</strong>: enter <strong>actual bank credit</strong> and optional <strong>TDS % on taxable</strong>; the app auto-calculates deducted TDS amount and settlement (₹ in bank + ₹ TDS = settlement). <strong>Paid</strong> opens the same payment dialog so you can record TDS% while settling the balance. Ledger posts only the actual bank credit; TDS is reconciled via Form 26AS / TDS certificates.
            </div>
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
              <button type="button" onClick={openCreateInvoiceModal} style={{ ...S.btn, fontSize: 11, padding: "5px 11px" }}>
                + New invoice
              </button>
              <button type="button" onClick={() => exportInvoicesCsv(filteredInvList)} disabled={!filteredInvList.length} style={{ ...S.btnO, fontSize: 11, padding: "5px 11px", opacity: filteredInvList.length ? 1 : 0.45 }}>
                ⬇ Export filtered
              </button>
            </div>

            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                marginBottom: 10,
                color: SKY.muted,
                fontSize: 12,
              }}
            >
              <span>
                Showing{" "}
                <strong style={{ color: SKY.text }}>{filteredInvList.length ? (invTablePage - 1) * invPageSize + 1 : 0}</strong> to{" "}
                <strong style={{ color: SKY.text }}>{Math.min(invTablePage * invPageSize, filteredInvList.length)}</strong> of{" "}
                <strong style={{ color: SKY.text }}>{filteredInvList.length}</strong> Invoices
              </span>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                <button
                  type="button"
                  disabled={invTablePage <= 1}
                  onClick={() => setInvTablePage(p => Math.max(1, p - 1))}
                  style={{ ...S.btnO, fontSize: 11, padding: "4px 10px", opacity: invTablePage <= 1 ? 0.4 : 1 }}
                  aria-label="Previous page"
                >
                  ‹
                </button>
                {invTotalPages <= 12 ? (
                  Array.from({ length: invTotalPages }, (_, i) => i + 1).map(p => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setInvTablePage(p)}
                      style={{
                        ...S.btnO,
                        minWidth: 30,
                        padding: "4px 8px",
                        fontSize: 11,
                        fontWeight: invTablePage === p ? 800 : 600,
                        background: invTablePage === p ? "rgba(107,122,255,.14)" : "transparent",
                        borderColor: invTablePage === p ? `${JM.p}66` : SKY.borderHi,
                        color: invTablePage === p ? JM.p : SKY.text2,
                      }}
                    >
                      {p}
                    </button>
                  ))
                ) : (
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#0c4a6e", padding: "0 6px" }}>
                    {invTablePage} / {invTotalPages}
                  </span>
                )}
                <button
                  type="button"
                  disabled={invTablePage >= invTotalPages}
                  onClick={() => setInvTablePage(p => Math.min(invTotalPages, p + 1))}
                  style={{ ...S.btnO, fontSize: 11, padding: "4px 10px", opacity: invTablePage >= invTotalPages ? 0.4 : 1 }}
                  aria-label="Next page"
                >
                  ›
                </button>
                <span style={{ fontSize: 10, color: "#94a3b8" }}>Rows</span>
                <select value={String(invPageSize)} onChange={e => setInvPageSize(Number(e.target.value))} style={{ ...hdrInput, width: 72, cursor: "pointer" }}>
                  {[10, 25, 50, 100].map(n => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                <div style={{ position: "relative" }} onClick={e => e.stopPropagation()}>
                  <button
                    type="button"
                    onClick={() => setInvColMenuOpen(o => !o)}
                    style={{
                      ...S.btnO,
                      fontSize: 11,
                      padding: "5px 11px",
                      borderColor: `${JM.p}55`,
                      color: JM.p,
                      fontWeight: 600,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <span aria-hidden>☰</span> Show/Hide Columns
                  </button>
                  {invColMenuOpen ? (
                    <div
                      style={{
                        position: "absolute",
                        right: 0,
                        top: "100%",
                        marginTop: 6,
                        zIndex: 20,
                        background: SKY.surface,
                        border: `1px solid ${SKY.borderHi}`,
                        borderRadius: 10,
                        padding: "10px 12px",
                        minWidth: 200,
                        boxShadow: "0 8px 24px rgba(15,23,42,.12)",
                      }}
                    >
                      {[
                        ["idx", "#"],
                        ["expand", "Items +"],
                        ["date", "Date"],
                        ["invoice", "Invoice"],
                        ["billedTo", "Billed to"],
                        ["amount", "Amount"],
                        ["status", "Status"],
                        ["nextSched", "Next scheduled"],
                        ["payDate", "Payment date"],
                      ].map(([k, lab]) => (
                        <label
                          key={k}
                          style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: SKY.text, marginBottom: 6, cursor: "pointer" }}
                        >
                          <input
                            type="checkbox"
                            checked={invColVis[k]}
                            onChange={e => setInvColVis(v => ({ ...v, [k]: e.target.checked }))}
                          />
                          {lab}
                        </label>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            <div style={{ overflowX: "auto", borderRadius: 10, border: `1px solid ${SKY.border}`, background: SKY.surface }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: SKY.surface2 }}>
                    <th style={{ padding: "10px 8px", width: 36, borderBottom: `1px solid ${SKY.borderHi}` }}>
                      <input
                        ref={invListHeaderCbRef}
                        type="checkbox"
                        checked={allInvPageSelected}
                        onChange={e => {
                          const on = e.target.checked
                          setInvSelectedIds(prev => {
                            const next = new Set(prev)
                            if (on) paginatedInv.forEach(r => next.add(r.id))
                            else paginatedInv.forEach(r => next.delete(r.id))
                            return next
                          })
                        }}
                        title="Select page"
                        aria-label="Select all on page"
                      />
                    </th>
                    {invColVis.idx ? (
                      <th style={{ padding: "10px 8px", textAlign: "left", fontSize: 10, fontWeight: 700, color: SKY.text2, borderBottom: `1px solid ${SKY.borderHi}`, whiteSpace: "nowrap" }}>#</th>
                    ) : null}
                    {invColVis.expand ? (
                      <th style={{ padding: "10px 8px", minWidth: 88, borderBottom: `1px solid ${SKY.borderHi}`, whiteSpace: "nowrap" }} title="Line items (expand)">
                        <span style={{ fontSize: 10, fontWeight: 700, color: SKY.text2 }}>Items +</span>
                      </th>
                    ) : null}
                    {invColVis.date ? (
                      <th style={{ padding: "10px 8px", textAlign: "left", fontSize: 10, fontWeight: 700, color: SKY.text2, borderBottom: `1px solid ${SKY.borderHi}`, whiteSpace: "nowrap" }}>
                        Date
                      </th>
                    ) : null}
                    {invColVis.invoice ? (
                      <th style={{ padding: "10px 8px", textAlign: "left", fontSize: 10, fontWeight: 700, color: SKY.text2, borderBottom: `1px solid ${SKY.borderHi}`, whiteSpace: "nowrap" }}>
                        Invoice
                      </th>
                    ) : null}
                    {invColVis.billedTo ? (
                      <th style={{ padding: "10px 8px", textAlign: "left", fontSize: 10, fontWeight: 700, color: SKY.text2, borderBottom: `1px solid ${SKY.borderHi}`, whiteSpace: "nowrap" }}>
                        Billed to
                      </th>
                    ) : null}
                    {invColVis.amount ? (
                      <th style={{ padding: "10px 8px", textAlign: "right", fontSize: 10, fontWeight: 700, color: SKY.text2, borderBottom: `1px solid ${SKY.borderHi}`, whiteSpace: "nowrap" }}>
                        Amount
                      </th>
                    ) : null}
                    {invColVis.status ? (
                      <th style={{ padding: "10px 8px", textAlign: "left", fontSize: 10, fontWeight: 700, color: SKY.text2, borderBottom: `1px solid ${SKY.borderHi}`, whiteSpace: "nowrap" }}>
                        Status
                      </th>
                    ) : null}
                    {invColVis.nextSched ? (
                      <th style={{ padding: "10px 8px", textAlign: "left", fontSize: 10, fontWeight: 700, color: SKY.text2, borderBottom: `1px solid ${SKY.borderHi}`, whiteSpace: "nowrap" }}>
                        Next scheduled
                      </th>
                    ) : null}
                    {invColVis.payDate ? (
                      <th style={{ padding: "10px 8px", textAlign: "left", fontSize: 10, fontWeight: 700, color: SKY.text2, borderBottom: `1px solid ${SKY.borderHi}`, whiteSpace: "nowrap" }}>
                        Payment date
                      </th>
                    ) : null}
                    <th style={{ padding: "10px 8px", textAlign: "right", fontSize: 10, fontWeight: 700, color: SKY.text2, borderBottom: `1px solid ${SKY.borderHi}`, whiteSpace: "nowrap" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedInv.length === 0 ? (
                    <tr>
                      <td colSpan={invListColSpan} style={{ padding: 28, textAlign: "center", color: SKY.muted2 }}>
                        No invoices match filters — adjust above or create one.
                      </td>
                    </tr>
                  ) : (
                    paginatedInv.map((r, iRow) => {
                      const rowIdx = (invTablePage - 1) * invPageSize + iRow + 1
                      const expanded = invExpandedIds.has(r.id)
                      const u = invoiceUiStatus(r)
                      const dueStr = formatIsoNice(r.dueDate || r.date)
                      const split = splitStoredInvoiceDesc(r.desc)
                      const paidIso = r.paidAt && String(r.paidAt).trim() ? String(r.paidAt).split("T")[0] : ""
                      const payDateDisplay =
                        paidIso && paidIso.length >= 8
                          ? formatIsoNice(paidIso)
                          : u === "paid"
                            ? formatIsoNice(r.date)
                            : "—"
                      const invActBtn = {
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 5,
                        background: SKY.surface2,
                        border: `1px solid ${SKY.borderHi}`,
                        borderRadius: 6,
                        padding: "4px 9px",
                        fontSize: 10,
                        fontWeight: 600,
                        color: "#334155",
                        whiteSpace: "nowrap",
                        lineHeight: 1.25,
                        cursor: acctRole === "Viewer" ? "default" : "pointer",
                        opacity: acctRole === "Viewer" ? 0.45 : 1,
                      }
                      return (
                        <Fragment key={r.id}>
                          <tr
                            onMouseEnter={e => (e.currentTarget.style.background = SKY.hover)}
                            onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                            style={{ borderBottom: `1px solid ${SKY.rowLine}`, transition: "background .1s" }}
                          >
                            <td style={{ padding: "8px", verticalAlign: "middle" }}>
                              <input
                                type="checkbox"
                                checked={invSelectedIds.has(r.id)}
                                onChange={e => {
                                  const on = e.target.checked
                                  setInvSelectedIds(prev => {
                                    const next = new Set(prev)
                                    if (on) next.add(r.id)
                                    else next.delete(r.id)
                                    return next
                                  })
                                }}
                              />
                            </td>
                            {invColVis.idx ? (
                              <td style={{ padding: "8px", color: SKY.muted, fontSize: 11, verticalAlign: "middle" }}>{rowIdx}</td>
                            ) : null}
                            {invColVis.expand ? (
                              <td style={{ padding: "8px", verticalAlign: "middle" }}>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setInvExpandedIds(prev => {
                                      const next = new Set(prev)
                                      if (next.has(r.id)) next.delete(r.id)
                                      else next.add(r.id)
                                      return next
                                    })
                                  }}
                                  title={expanded ? "Collapse line items" : "Expand line items"}
                                  style={{
                                    borderRadius: 6,
                                    border: `1px solid ${SKY.borderHi}`,
                                    background: SKY.surface2,
                                    cursor: "pointer",
                                    fontWeight: 700,
                                    fontSize: 10,
                                    color: JM.p,
                                    lineHeight: 1.2,
                                    padding: "5px 10px",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {expanded ? "Hide −" : "Show +"}
                                </button>
                              </td>
                            ) : null}
                            {invColVis.date ? (
                              <td style={{ padding: "8px", fontWeight: 600, color: SKY.text, verticalAlign: "middle", whiteSpace: "nowrap" }}>{formatIsoNice(r.date)}</td>
                            ) : null}
                            {invColVis.invoice ? (
                              <td style={{ padding: "8px", fontWeight: 700, color: "#0c4a6e", verticalAlign: "middle" }}>{r.num}</td>
                            ) : null}
                            {invColVis.billedTo ? (
                              <td style={{ padding: "8px", maxWidth: 220, verticalAlign: "middle" }}>
                                <span style={{ fontSize: 12, color: SKY.text }}>{String(r.client || "").slice(0, 36)}</span>
                                {String(r.client || "").length > 36 ? "…" : ""}
                              </td>
                            ) : null}
                            {invColVis.amount ? (
                              <td style={{ padding: "8px", textAlign: "right", fontFamily: "monospace", fontWeight: 700, verticalAlign: "middle", whiteSpace: "nowrap" }}>₹{inr(r.total)}</td>
                            ) : null}
                            {invColVis.status ? (
                              <td style={{ padding: "8px", verticalAlign: "middle" }}>
                                {u === "paid" ? (
                                  <span style={{ ...pillStyle("Revenue", "Paid"), background: "#d1fae5", color: "#047857", border: "1px solid #6ee7b7" }}>Paid</span>
                                ) : u === "overdue" ? (
                                  <div>
                                    <span style={{ ...pillStyle("Director Payment", "Overdue"), background: "#fee2e2", color: "#b91c1c", border: "1px solid #fecaca" }}>Overdue</span>
                                    <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 2 }}>Due on {dueStr}</div>
                                  </div>
                                ) : u === "partial" ? (
                                  <div>
                                    <span style={{ ...pillStyle("Bank Charges", "Partial"), background: "#fef3c7", color: "#b45309", border: "1px solid #fde68a" }}>Partial</span>
                                    <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 2 }}>Due on {dueStr}</div>
                                  </div>
                                ) : (
                                  <div>
                                    <span style={{ ...pillStyle("Misc Expense", "Unpaid"), background: "#ffedd5", color: "#c2410c", border: "1px solid #fed7aa" }}>Unpaid</span>
                                    <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 2 }}>Due on {dueStr}</div>
                                  </div>
                                )}
                              </td>
                            ) : null}
                            {invColVis.nextSched ? (
                              <td style={{ padding: "8px", color: SKY.muted, fontSize: 11, verticalAlign: "middle" }}>—</td>
                            ) : null}
                            {invColVis.payDate ? (
                              <td style={{ padding: "8px", color: SKY.muted, fontSize: 11, verticalAlign: "middle", whiteSpace: "nowrap" }}>{payDateDisplay}</td>
                            ) : null}
                            <td style={{ padding: "8px", textAlign: "right", verticalAlign: "middle", position: "relative" }}>
                              <div
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: 5,
                                  flexWrap: "wrap",
                                  justifyContent: "flex-end",
                                  maxWidth: 420,
                                }}
                              >
                                <button type="button" title="Print or save as PDF" onClick={() => printSavedInvoice(r)} style={invActBtn}>
                                  Print <span aria-hidden>↗</span>
                                </button>
                                <button type="button" title="Edit invoice" disabled={acctRole === "Viewer"} onClick={() => openEditInvoiceModal(r)} style={invActBtn}>
                                  Edit <span aria-hidden>✎</span>
                                </button>
                                {u !== "paid" ? (
                                  <button type="button" title="Mark as paid" disabled={acctRole === "Viewer"} onClick={() => markInvoicePaidFull(r.id)} style={invActBtn}>
                                    Paid <span aria-hidden>✓</span>
                                  </button>
                                ) : null}
                                <button type="button" title="Duplicate invoice" disabled={acctRole === "Viewer"} onClick={() => duplicateInvoice(r)} style={invActBtn}>
                                  Dup <span aria-hidden>⧉</span>
                                </button>
                                <button
                                  type="button"
                                  title="More actions"
                                  disabled={acctRole === "Viewer"}
                                  onClick={() => setInvMoreMenuId(invMoreMenuId === r.id ? null : r.id)}
                                  style={invActBtn}
                                >
                                  More <span aria-hidden>⋯</span>
                                </button>
                              </div>
                              {invMoreMenuId === r.id ? (
                                <div
                                  onClick={e => e.stopPropagation()}
                                  style={{
                                    position: "absolute",
                                    right: 8,
                                    top: "100%",
                                    marginTop: 4,
                                    zIndex: 25,
                                    background: SKY.surface,
                                    border: `1px solid ${SKY.borderHi}`,
                                    borderRadius: 8,
                                    boxShadow: "0 8px 24px rgba(15,23,42,.12)",
                                    minWidth: 160,
                                    textAlign: "left",
                                  }}
                                >
                                  <button
                                    type="button"
                                    disabled={acctRole === "Viewer"}
                                    onClick={() => {
                                      openInvoicePaymentModal(r, "add")
                                      setInvMoreMenuId(null)
                                    }}
                                    style={{
                                      display: "block",
                                      width: "100%",
                                      padding: "8px 12px",
                                      border: "none",
                                      background: "none",
                                      textAlign: "left",
                                      fontSize: 12,
                                      cursor: acctRole === "Viewer" ? "default" : "pointer",
                                      color: SKY.text,
                                    }}
                                  >
                                    Record payment…
                                  </button>
                                  {invoiceUiStatus(r) === "paid" ? (
                                    <button
                                      type="button"
                                      disabled={acctRole === "Viewer"}
                                      onClick={() => {
                                        openInvoicePaymentModal(r, "replace")
                                        setInvMoreMenuId(null)
                                      }}
                                      style={{
                                        display: "block",
                                        width: "100%",
                                        padding: "8px 12px",
                                        border: "none",
                                        borderTop: `1px solid ${SKY.border}`,
                                        background: "none",
                                        textAlign: "left",
                                        fontSize: 12,
                                        cursor: acctRole === "Viewer" ? "default" : "pointer",
                                        color: SKY.text,
                                      }}
                                    >
                                      Change to partial…
                                    </button>
                                  ) : null}
                                  {(Number(r.paidAmount) || 0) > 0.005 ? (
                                    <button
                                      type="button"
                                      disabled={acctRole === "Viewer"}
                                      onClick={() => {
                                        markInvoiceUnpaid(r.id)
                                        setInvMoreMenuId(null)
                                      }}
                                      style={{
                                        display: "block",
                                        width: "100%",
                                        padding: "8px 12px",
                                        border: "none",
                                        borderTop: `1px solid ${SKY.border}`,
                                        background: "none",
                                        textAlign: "left",
                                        fontSize: 12,
                                        cursor: acctRole === "Viewer" ? "default" : "pointer",
                                        color: "#b45309",
                                      }}
                                    >
                                      Mark as unpaid
                                    </button>
                                  ) : null}
                                  <button
                                    type="button"
                                    disabled={acctRole === "Viewer"}
                                    onClick={() => {
                                      openInvoiceDeleteConfirm(r.id)
                                      setInvMoreMenuId(null)
                                    }}
                                    style={{
                                      display: "block",
                                      width: "100%",
                                      padding: "8px 12px",
                                      border: "none",
                                      borderTop: `1px solid ${SKY.border}`,
                                      background: "none",
                                      textAlign: "left",
                                      fontSize: 12,
                                      cursor: acctRole === "Viewer" ? "default" : "pointer",
                                      color: "#f43f5e",
                                    }}
                                  >
                                    Remove from register…
                                  </button>
                                </div>
                              ) : null}
                            </td>
                          </tr>
                          {expanded ? (
                            <tr key={`${r.id}-detail`} style={{ background: SKY.surface2 }}>
                              <td colSpan={invListColSpan} style={{ padding: 0, borderBottom: `1px solid ${SKY.borderHi}` }}>
                                <div style={{ padding: "15px 18px 18px" }}>
                                  <div style={{ fontSize: 10, fontWeight: 800, color: JM.p, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 10 }}>Line items &amp; tax</div>
                                  <div
                                    style={{
                                      display: "grid",
                                      gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                                      gap: 12,
                                      fontSize: 12,
                                      color: SKY.text,
                                      lineHeight: 1.45,
                                    }}
                                  >
                                    <div>
                                      <strong style={{ color: SKY.muted, fontSize: 10 }}>Item</strong>
                                      <div>{split.itemName || "—"}</div>
                                    </div>
                                    <div>
                                      <strong style={{ color: SKY.muted, fontSize: 10 }}>Description</strong>
                                      <div style={{ whiteSpace: "pre-wrap" }}>{split.descExtra || "—"}</div>
                                    </div>
                                    <div>
                                      <strong style={{ color: SKY.muted, fontSize: 10 }}>Subtitle</strong>
                                      <div>{r.subtitle || "—"}</div>
                                    </div>
                                    <div>
                                      <strong style={{ color: SKY.muted, fontSize: 10 }}>SAC / HSN</strong>
                                      <div>{r.sac || "—"}</div>
                                    </div>
                                    <div>
                                      <strong style={{ color: SKY.muted, fontSize: 10 }}>Place</strong>
                                      <div>{r.place === "inter" ? "Inter-state (IGST)" : "Intra-state (CGST+SGST)"}</div>
                                    </div>
                                    <div>
                                      <strong style={{ color: SKY.muted, fontSize: 10 }}>Taxable</strong>
                                      <div style={{ fontFamily: "monospace" }}>₹{inr(r.taxable)}</div>
                                    </div>
                                    <div>
                                      <strong style={{ color: SKY.muted, fontSize: 10 }}>GST</strong>
                                      <div style={{ fontFamily: "monospace", fontSize: 11 }}>
                                        {r.igst > 0 ? `IGST ₹${inr(r.igst)}` : `CGST ₹${inr(r.cgst)} · SGST ₹${inr(r.sgst)}`}
                                      </div>
                                    </div>
                                    <div>
                                      <strong style={{ color: SKY.muted, fontSize: 10 }}>Revenue category</strong>
                                      <div>{r.revenueCategory || "—"}</div>
                                    </div>
                                    <div>
                                      <strong style={{ color: SKY.muted, fontSize: 10 }}>Bank / TDS</strong>
                                      <div style={{ fontFamily: "monospace", fontSize: 11 }}>
                                        B ₹{inr(Number(r.paidBankTotal != null ? r.paidBankTotal : r.paidAmount) || 0)}
                                        {(Number(r.paidTdsTotal) || 0) > 0 ? <span style={{ display: "block", color: "#0369a1" }}>TDS ₹{inr(r.paidTdsTotal)}</span> : null}
                                      </div>
                                    </div>
                                    <div>
                                      <strong style={{ color: SKY.muted, fontSize: 10 }}>Balance due</strong>
                                      <div style={{ fontFamily: "monospace", color: invoiceBalance(r) > 0 ? "#f59e0b" : "#64748b" }}>₹{inr(invoiceBalance(r))}</div>
                                    </div>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>

            {!shareEarnInvHidden ? (
              <div
                style={{
                  position: "relative",
                  marginTop: 14,
                  borderRadius: 12,
                  overflow: "hidden",
                  border: "1px solid rgba(107,122,255,.2)",
                  background: "linear-gradient(125deg, #e0f2fe 0%, #f1f5f9 42%, #e8e0fe 100%)",
                  boxShadow: "0 4px 20px rgba(15,23,42,.06)",
                }}
              >
                <button
                  type="button"
                  aria-label="Dismiss"
                  onClick={() => {
                    setShareEarnInvHidden(true)
                    try {
                      localStorage.setItem("jm_hide_share_earn_inv", "1")
                    } catch {
                      /* ignore */
                    }
                  }}
                  style={{
                    position: "absolute",
                    top: 10,
                    right: 12,
                    border: "none",
                    background: "rgba(255,255,255,.65)",
                    borderRadius: 8,
                    width: 30,
                    height: 30,
                    cursor: "pointer",
                    fontSize: 16,
                    lineHeight: 1,
                    color: "#64748b",
                    zIndex: 2,
                  }}
                >
                  ×
                </button>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 16,
                    padding: "22px 44px 22px 22px",
                  }}
                >
                  <div style={{ minWidth: 0, flex: "1 1 260px" }}>
                    <div style={{ fontSize: 18, fontWeight: 800, color: "#0c4a6e", letterSpacing: "-0.02em" }}>Share and Earn</div>
                    <div style={{ fontSize: 13, color: "#475569", marginTop: 8, lineHeight: 1.55, maxWidth: 520 }}>
                      Invite your friends and get <strong style={{ color: "#0c4a6e" }}>300 JM Tally credits</strong> when they sign up and start using the app.
                    </div>
                    <button
                      type="button"
                      onClick={() => toast_("Referral program — details coming soon. Thanks for your interest!", "#6366f1")}
                      style={{
                        marginTop: 14,
                        border: "none",
                        borderRadius: 8,
                        padding: "10px 18px",
                        fontSize: 13,
                        fontWeight: 700,
                        color: "#fff",
                        cursor: "pointer",
                        background: "linear-gradient(135deg, #ec4899, #db2777)",
                        boxShadow: "0 4px 14px rgba(219,39,119,.35)",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      Learn more <span aria-hidden>→</span>
                    </button>
                  </div>
                  <div
                    style={{
                      justifySelf: "end",
                      opacity: 0.95,
                      pointerEvents: "none",
                      userSelect: "none",
                    }}
                    aria-hidden
                  >
                    <svg width={180} height={100} viewBox="0 0 180 100" style={{ maxWidth: "100%", height: "auto" }}>
                      <defs>
                        <linearGradient id="coinG" x1="0" y1="0" x2="1" y2="1">
                          <stop offset="0%" stopColor="#fcd34d" />
                          <stop offset="100%" stopColor="#f59e0b" />
                        </linearGradient>
                      </defs>
                      <circle cx={42} cy={28} r={14} fill="url(#coinG)" stroke="#d97706" strokeWidth={1.2} />
                      <text x={42} y={33} textAnchor="middle" fontSize={14} fontWeight={800} fill="#92400e">
                        ₹
                      </text>
                      <circle cx={78} cy={18} r={11} fill="url(#coinG)" stroke="#d97706" strokeWidth={1} opacity={0.92} />
                      <text x={78} y={22} textAnchor="middle" fontSize={11} fontWeight={800} fill="#92400e">
                        ₹
                      </text>
                      <circle cx={118} cy={32} r={9} fill="#fde68a" stroke="#b45309" strokeWidth={0.8} />
                      <path
                        d="M128 78 L152 62 L168 78 L168 92 L128 92 Z"
                        fill="#a855f7"
                        stroke="#7c3aed"
                        strokeWidth={1.2}
                      />
                      <path d="M128 78 L148 66 L148 78 Z" fill="#c4b5fd" opacity={0.9} />
                      <rect x={138} y={52} width={16} height={10} rx={2} fill="#fbbf24" stroke="#d97706" />
                      <path d="M146 52 L146 46 Q146 42 150 42 Q154 42 154 46 L154 52" fill="#fbbf24" stroke="#d97706" strokeWidth={1} />
                      <circle cx={24} cy={58} r={3} fill="#fbbf24" opacity={0.9} />
                      <circle cx={160} cy={44} r={2.5} fill="#fbbf24" opacity={0.85} />
                      <circle cx={98} cy={8} r={2} fill="#fbbf24" />
                    </svg>
                  </div>
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {invPrimaryTab === "bank" ? (
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
        ) : null}
        </div>
    )
  }

  const Clients = () => {
    const [cliView, setCliView] = useState("manage")
    const [cliExpandedKey, setCliExpandedKey] = useState(null)
    const [cliLedgerKey, setCliLedgerKey] = useState("")
    const [cliWiseKey, setCliWiseKey] = useState("")
    const [cliRepFrom, setCliRepFrom] = useState(() => {
      const d = new Date()
      d.setMonth(d.getMonth() - 3)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    })
    const [cliRepTo, setCliRepTo] = useState(todayISO())
    const [cliRepPage, setCliRepPage] = useState(1)
    const [cliRepPageSize, setCliRepPageSize] = useState(10)

    const clientRows = useMemo(() => {
      const presets = invoiceClientPresets
      return presets.map(p => {
        const rel = invoices.filter(inv => {
          const n = String(inv.client || "").trim().toLowerCase()
          const g = String(inv.gstin || "").trim().toUpperCase()
          return n === String(p.client || "").trim().toLowerCase() && g === String(p.gstin || "").trim().toUpperCase()
        })
        const invCount = rel.length
        const outstand = Math.round(rel.reduce((s, i) => s + Math.max(0, invoiceBalance(i)), 0) * 100) / 100
        return { key: p.key, client: p.client, gstin: p.gstin || "", place: p.place, invCount, outstand, rel }
      })
    }, [invoices, invoiceClientPresets])

    const clientReportRows = useMemo(() => {
      const fromT = cliRepFrom ? Date.parse(`${cliRepFrom}T00:00:00`) : -Infinity
      const toT = cliRepTo ? Date.parse(`${cliRepTo}T23:59:59`) : Infinity
      const presets = invoiceClientPresets
      return presets.map(p => {
        const rel = invoices.filter(inv => {
          const n = String(inv.client || "").trim().toLowerCase()
          const g = String(inv.gstin || "").trim().toUpperCase()
          if (n !== String(p.client || "").trim().toLowerCase() || g !== String(p.gstin || "").trim().toUpperCase()) return false
          const t = Date.parse(inv.date)
          return Number.isFinite(t) && t >= fromT && t <= toT
        })
        let lastIso = ""
        for (const inv of rel) {
          const d = String(inv.date || "")
          if (d && (!lastIso || d > lastIso)) lastIso = d
        }
        const totalInvoiced = rel.reduce((s, i) => s + (Number(i.total) || 0), 0)
        const pending = Math.round(rel.reduce((s, i) => s + Math.max(0, invoiceBalance(i)), 0) * 100) / 100
        const tdsSum = rel.reduce((s, i) => s + (Number(i.paidTdsTotal) || 0), 0)
        const gstSum = rel.reduce((s, i) => s + (Number(i.cgst) || 0) + (Number(i.sgst) || 0) + (Number(i.igst) || 0), 0)
        const payDays = []
        for (const inv of rel) {
          const tot = Number(inv.total) || 0
          const paid = Number(inv.paidAmount) || 0
          if (tot < 0.01 || paid < tot - 0.02) continue
          const d0 = Date.parse(inv.date)
          const d1 = Date.parse(inv.paidAt || inv.date)
          if (Number.isFinite(d0) && Number.isFinite(d1) && d1 >= d0) payDays.push(Math.round((d1 - d0) / 86400000))
        }
        const avgPay = payDays.length ? Math.round(payDays.reduce((a, b) => a + b, 0) / payDays.length) : null
        return {
          key: p.key,
          client: p.client,
          gstin: p.gstin || "",
          place: p.place,
          lastInvoiceDate: lastIso ? formatIsoNice(lastIso) : "—",
          invCount: rel.length,
          totalInvoiced,
          pending,
          netDue: pending,
          tdsSum,
          gstSum,
          avgPayDays: avgPay,
        }
      })
    }, [invoices, cliRepFrom, cliRepTo, invoiceClientPresets])

    const clientWiseInvoices = useMemo(() => {
      if (!cliWiseKey) return []
      const p = invoiceClientPresets.find(x => x.key === cliWiseKey)
      if (!p) return []
      const fromT = cliRepFrom ? Date.parse(`${cliRepFrom}T00:00:00`) : -Infinity
      const toT = cliRepTo ? Date.parse(`${cliRepTo}T23:59:59`) : Infinity
      return invoices
        .filter(inv => {
          const n = String(inv.client || "").trim().toLowerCase()
          const g = String(inv.gstin || "").trim().toUpperCase()
          if (n !== String(p.client || "").trim().toLowerCase() || g !== String(p.gstin || "").trim().toUpperCase()) return false
          const t = Date.parse(inv.date)
          return Number.isFinite(t) && t >= fromT && t <= toT
        })
        .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0))
    }, [cliWiseKey, cliRepFrom, cliRepTo, invoices, invoiceClientPresets])

    const clientWiseRow = useMemo(
      () => (cliWiseKey ? clientReportRows.find(r => r.key === cliWiseKey) || null : null),
      [cliWiseKey, clientReportRows]
    )

    useEffect(() => {
      if (cliView === "ledger" && !cliLedgerKey && clientRows.length === 1) setCliLedgerKey(clientRows[0].key)
    }, [cliView, cliLedgerKey, clientRows])

    useEffect(() => {
      if (cliView === "clientwise" && !cliWiseKey && clientRows.length === 1) setCliWiseKey(clientRows[0].key)
    }, [cliView, cliWiseKey, clientRows])

    const cliRepTotalPages = Math.max(1, Math.ceil(clientReportRows.length / cliRepPageSize))
    const cliRepPaginated = useMemo(() => {
      const start = (cliRepPage - 1) * cliRepPageSize
      return clientReportRows.slice(start, start + cliRepPageSize)
    }, [clientReportRows, cliRepPage, cliRepPageSize])

    useEffect(() => {
      setCliRepPage(1)
    }, [cliRepFrom, cliRepTo, cliRepPageSize])

    const exportClientReportCsv = () => {
      const h = [
        "Client",
        "GSTIN",
        "Last invoice date",
        "Invoices (in range)",
        "Total invoiced",
        "Pending",
        "Net due",
        "TDS",
        "Total GST",
        "Avg pay days",
      ]
      const lines = clientReportRows.map(r =>
        [
          `"${String(r.client).replace(/"/g, '""')}"`,
          r.gstin || "",
          r.lastInvoiceDate,
          r.invCount,
          r.totalInvoiced,
          r.pending,
          r.netDue,
          r.tdsSum,
          r.gstSum,
          r.avgPayDays != null ? r.avgPayDays : "",
        ].join(",")
      )
      const blob = new Blob([[h.join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" })
      const a = document.createElement("a")
      a.href = URL.createObjectURL(blob)
      a.download = "jm_tally_clients_report.csv"
      a.click()
      URL.revokeObjectURL(a.href)
      toast_("Client report exported", "#10b981")
    }

    const totOut = clientRows.reduce((s, r) => s + r.outstand, 0)
    const hdrInputLocal = { ...hdrInput }

    const openEditClient = r => {
      if (acctRole === "Viewer") return
      setEditClientPresetKey(r.key)
      const man = manualClients.find(m => manualClientKey(m) === r.key)
      setEditManualClientId(man ? man.id : null)
      setModal("addClient")
    }
    const thRep = {
      padding: "10px 8px",
      textAlign: "left",
      fontSize: 10,
      fontWeight: 700,
      color: SKY.text2,
      borderBottom: `1px solid ${SKY.borderHi}`,
      whiteSpace: "nowrap",
    }

    const renderClientLedgerPanel = r => {
      if (!r) {
        return (
          <div style={{ padding: 24, textAlign: "center", color: SKY.muted2, fontSize: 12, lineHeight: 1.55 }}>
            Select a client to see summary and invoice ledger (all invoices for that party).
          </div>
        )
      }
      const relSorted = [...r.rel].sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0))
      const totalInv = r.rel.reduce((s, i) => s + (Number(i.total) || 0), 0)
      const tdsA = r.rel.reduce((s, i) => s + (Number(i.paidTdsTotal) || 0), 0)
      const gstA = r.rel.reduce((s, i) => s + (Number(i.cgst) || 0) + (Number(i.sgst) || 0) + (Number(i.igst) || 0), 0)
      return (
        <div style={{ padding: "14px 16px 18px" }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: JM.p, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 10 }}>Client summary</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 10, fontSize: 11, marginBottom: 16, color: SKY.text }}>
            <div>
              <span style={{ color: SKY.muted }}>Total invoiced</span>
              <div style={{ fontFamily: "monospace", fontWeight: 700 }}>₹{inr(totalInv)}</div>
            </div>
            <div>
              <span style={{ color: SKY.muted }}>Outstanding</span>
              <div style={{ fontFamily: "monospace", fontWeight: 700, color: "#f59e0b" }}>₹{inr(r.outstand)}</div>
            </div>
            <div>
              <span style={{ color: SKY.muted }}>TDS (recorded)</span>
              <div style={{ fontFamily: "monospace" }}>₹{inr(tdsA)}</div>
            </div>
            <div>
              <span style={{ color: SKY.muted }}>GST on invoices</span>
              <div style={{ fontFamily: "monospace" }}>₹{inr(gstA)}</div>
            </div>
          </div>
          <div style={{ fontSize: 10, fontWeight: 800, color: JM.p, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>Client ledger (invoices)</div>
          <div style={{ overflowX: "auto", borderRadius: 8, border: `1px solid ${SKY.border}` }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead>
                <tr style={{ background: SKY.surface }}>
                  <th style={{ padding: 6, textAlign: "left", fontSize: 9, color: SKY.text2 }}>Date</th>
                  <th style={{ padding: 6, textAlign: "left", fontSize: 9, color: SKY.text2 }}>Invoice</th>
                  <th style={{ padding: 6, textAlign: "right", fontSize: 9, color: SKY.text2 }}>Total</th>
                  <th style={{ padding: 6, textAlign: "right", fontSize: 9, color: SKY.text2 }}>Bank</th>
                  <th style={{ padding: 6, textAlign: "right", fontSize: 9, color: SKY.text2 }}>Balance</th>
                  <th style={{ padding: 6, textAlign: "left", fontSize: 9, color: SKY.text2 }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {relSorted.map(inv => {
                  const st = invoiceUiStatus(inv)
                  return (
                    <tr key={inv.id} style={{ borderTop: `1px solid ${SKY.rowLine}` }}>
                      <td style={{ padding: 6, whiteSpace: "nowrap" }}>{formatIsoNice(inv.date)}</td>
                      <td style={{ padding: 6, fontWeight: 600 }}>{inv.num}</td>
                      <td style={{ padding: 6, textAlign: "right", fontFamily: "monospace" }}>₹{inr(inv.total)}</td>
                      <td style={{ padding: 6, textAlign: "right", fontFamily: "monospace", color: "#64748b" }}>₹{inr(invoiceBankReceived(inv))}</td>
                      <td style={{ padding: 6, textAlign: "right", fontFamily: "monospace", color: invoiceBalance(inv) > 0 ? "#f59e0b" : "#94a3b8" }}>₹{inr(invoiceBalance(inv))}</td>
                      <td style={{ padding: 6 }}>
                        <Chip cat={st === "paid" ? "Revenue" : st === "overdue" ? "Director Payment" : "Misc Expense"} label={st} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )
    }

    return (
      <div>
        <div style={S.g2}>
          <Stat label="Distinct clients" value={String(clientRows.length)} sub="From invoices" color="#0369a1" />
          <Stat label="Outstanding (all)" value={"₹" + inr0(totOut)} sub="Open invoice balance" color="#f59e0b" />
        </div>

        <div style={{ ...S.tabs, marginBottom: 12, flexWrap: "wrap" }}>
          <button type="button" onClick={() => setCliView("manage")} style={S.tab(cliView === "manage")}>
            Manage clients
          </button>
          <button type="button" onClick={() => setCliView("report")} style={S.tab(cliView === "report")}>
            Client report
          </button>
          <button type="button" onClick={() => setCliView("ledger")} style={S.tab(cliView === "ledger")}>
            Ledger of client
          </button>
          <button type="button" onClick={() => setCliView("clientwise")} style={S.tab(cliView === "clientwise")}>
            Client-wise report
          </button>
        </div>

        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 13, alignItems: "center" }}>
          <button
            type="button"
            disabled={acctRole === "Viewer"}
            onClick={() => {
              setEditManualClientId(null)
              setEditClientPresetKey(null)
              setModal("addClient")
            }}
            style={{ ...S.btn, fontSize: 11, padding: "5px 11px", opacity: acctRole === "Viewer" ? 0.45 : 1, cursor: acctRole === "Viewer" ? "default" : "pointer" }}
          >
            {acctRole === "Viewer" ? "View-only" : "+ Add client"}
          </button>
        </div>
        <div style={{ fontSize: 11, color: "#64748b", marginBottom: 12, lineHeight: 1.55 }}>
          Everything below stays on this page — <strong>Manage clients</strong> lists all parties with <strong>Show +</strong> (ledger) and <strong>Edit</strong>; <strong>Ledger of client</strong> and <strong>Client-wise report</strong> also have <strong>Edit client</strong> when a party is selected; <strong>Client report</strong> is date-range totals for everyone.
        </div>

        {cliView === "manage" ? (
          <div style={{ overflowX: "auto", borderRadius: 10, border: `1px solid ${SKY.border}`, background: SKY.surface }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: SKY.surface2 }}>
                  <th style={{ padding: "10px 8px", width: 108, textAlign: "left", fontSize: 10, fontWeight: 700, color: SKY.text2, borderBottom: `1px solid ${SKY.borderHi}` }}>Show / Edit</th>
                  <th style={{ padding: "10px 8px", textAlign: "left", fontSize: 10, fontWeight: 700, color: SKY.text2, borderBottom: `1px solid ${SKY.borderHi}` }}>Client</th>
                  <th style={{ padding: "10px 8px", textAlign: "left", fontSize: 10, fontWeight: 700, color: SKY.text2, borderBottom: `1px solid ${SKY.borderHi}` }}>GSTIN</th>
                  <th style={{ padding: "10px 8px", textAlign: "left", fontSize: 10, fontWeight: 700, color: SKY.text2, borderBottom: `1px solid ${SKY.borderHi}` }}>Place</th>
                  <th style={{ padding: "10px 8px", textAlign: "right", fontSize: 10, fontWeight: 700, color: SKY.text2, borderBottom: `1px solid ${SKY.borderHi}` }}>Invoices</th>
                  <th style={{ padding: "10px 8px", textAlign: "right", fontSize: 10, fontWeight: 700, color: SKY.text2, borderBottom: `1px solid ${SKY.borderHi}` }}>Outstanding (₹)</th>
                </tr>
              </thead>
              <tbody>
                {clientRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ padding: 28, textAlign: "center", color: SKY.muted2 }}>
                      No clients yet — use <strong>Add client</strong> above or create a sales invoice from the Invoices page.
                    </td>
                  </tr>
                ) : (
                  clientRows.map(r => {
                    const ex = cliExpandedKey === r.key
                    return (
                      <Fragment key={r.key}>
                        <tr
                          style={{ borderBottom: `1px solid ${SKY.rowLine}` }}
                          onMouseEnter={e => (e.currentTarget.style.background = SKY.hover)}
                          onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                        >
                          <td style={{ padding: 8, verticalAlign: "middle" }}>
                            <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
                              <button
                                type="button"
                                onClick={() => setCliExpandedKey(cliExpandedKey === r.key ? null : r.key)}
                                style={{
                                  borderRadius: 6,
                                  border: `1px solid ${SKY.borderHi}`,
                                  background: SKY.surface2,
                                  cursor: "pointer",
                                  fontWeight: 700,
                                  fontSize: 10,
                                  color: JM.p,
                                  padding: "5px 10px",
                                }}
                              >
                                {ex ? "Hide −" : "Show +"}
                              </button>
                              <button
                                type="button"
                                disabled={acctRole === "Viewer"}
                                onClick={() => openEditClient(r)}
                                style={{
                                  borderRadius: 6,
                                  border: `1px solid ${JM.p}55`,
                                  background: "rgba(107,122,255,.08)",
                                  cursor: acctRole === "Viewer" ? "default" : "pointer",
                                  fontWeight: 700,
                                  fontSize: 10,
                                  color: JM.p,
                                  padding: "5px 10px",
                                  opacity: acctRole === "Viewer" ? 0.45 : 1,
                                }}
                              >
                                Edit
                              </button>
                            </div>
                          </td>
                          <td style={{ padding: 8, fontWeight: 600, color: SKY.text }}>{r.client}</td>
                          <td style={{ padding: 8, fontSize: 11 }}>{r.gstin || "—"}</td>
                          <td style={{ padding: 8, fontSize: 10, color: "#94a3b8" }}>{r.place === "inter" ? "Inter-state" : "Intra-state"}</td>
                          <td style={{ padding: 8, textAlign: "right" }}>{r.invCount}</td>
                          <td style={{ padding: 8, textAlign: "right", fontFamily: "monospace", fontWeight: 700, color: r.outstand > 0 ? "#f59e0b" : "#94a3b8" }}>₹{inr(r.outstand)}</td>
                        </tr>
                        {ex ? (
                          <tr style={{ background: SKY.surface2 }}>
                            <td colSpan={6} style={{ padding: 0, borderBottom: `1px solid ${SKY.borderHi}` }}>{renderClientLedgerPanel(r)}</td>
                          </tr>
                        ) : null}
                      </Fragment>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        ) : null}

        {cliView === "report" ? (
          <>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: SKY.muted, textTransform: "uppercase" }}>Date range</span>
                <input type="date" value={cliRepFrom} onChange={e => setCliRepFrom(e.target.value)} style={{ ...hdrInputLocal, width: 140 }} />
                <span style={{ fontSize: 11, color: "#94a3b8" }}>to</span>
                <input type="date" value={cliRepTo} onChange={e => setCliRepTo(e.target.value)} style={{ ...hdrInputLocal, width: 140 }} />
              </div>
              <button type="button" onClick={exportClientReportCsv} disabled={!clientReportRows.length} style={{ ...S.btnO, fontSize: 11, padding: "5px 11px", opacity: clientReportRows.length ? 1 : 0.45 }}>
                ⬇ Download CSV
              </button>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10, fontSize: 12, color: SKY.muted }}>
              <span>
                Showing <strong style={{ color: SKY.text }}>{clientReportRows.length ? (cliRepPage - 1) * cliRepPageSize + 1 : 0}</strong> to{" "}
                <strong style={{ color: SKY.text }}>{Math.min(cliRepPage * cliRepPageSize, clientReportRows.length)}</strong> of{" "}
                <strong style={{ color: SKY.text }}>{clientReportRows.length}</strong> clients
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <button type="button" disabled={cliRepPage <= 1} onClick={() => setCliRepPage(p => Math.max(1, p - 1))} style={{ ...S.btnO, fontSize: 11, padding: "4px 10px", opacity: cliRepPage <= 1 ? 0.4 : 1 }}>
                  ‹
                </button>
                {cliRepTotalPages <= 12 ? (
                  Array.from({ length: cliRepTotalPages }, (_, i) => i + 1).map(p => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setCliRepPage(p)}
                      style={{
                        ...S.btnO,
                        minWidth: 28,
                        padding: "4px 8px",
                        fontSize: 11,
                        fontWeight: cliRepPage === p ? 800 : 600,
                        background: cliRepPage === p ? "rgba(107,122,255,.14)" : "transparent",
                        borderColor: cliRepPage === p ? `${JM.p}66` : SKY.borderHi,
                        color: cliRepPage === p ? JM.p : SKY.text2,
                      }}
                    >
                      {p}
                    </button>
                  ))
                ) : (
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#0c4a6e" }}>
                    {cliRepPage} / {cliRepTotalPages}
                  </span>
                )}
                <button
                  type="button"
                  disabled={cliRepPage >= cliRepTotalPages}
                  onClick={() => setCliRepPage(p => Math.min(cliRepTotalPages, p + 1))}
                  style={{ ...S.btnO, fontSize: 11, padding: "4px 10px", opacity: cliRepPage >= cliRepTotalPages ? 0.4 : 1 }}
                >
                  ›
                </button>
                <span style={{ fontSize: 10, color: "#94a3b8" }}>Rows</span>
                <select value={String(cliRepPageSize)} onChange={e => setCliRepPageSize(Number(e.target.value))} style={{ ...hdrInputLocal, width: 72, cursor: "pointer" }}>
                  {[10, 25, 50].map(n => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div style={{ overflowX: "auto", borderRadius: 10, border: `1px solid ${SKY.border}`, background: SKY.surface }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, minWidth: 960 }}>
                <thead>
                  <tr style={{ background: SKY.surface2 }}>
                    <th style={thRep}>Client</th>
                    <th style={thRep}>Last invoice</th>
                    <th style={{ ...thRep, textAlign: "right" }}>Invoices</th>
                    <th style={{ ...thRep, textAlign: "right" }}>Total invoiced</th>
                    <th style={{ ...thRep, textAlign: "right" }}>Pending</th>
                    <th style={{ ...thRep, textAlign: "right" }}>Net due</th>
                    <th style={{ ...thRep, textAlign: "right" }}>TDS</th>
                    <th style={{ ...thRep, textAlign: "right" }}>GST</th>
                    <th style={thRep}>Avg pay</th>
                  </tr>
                </thead>
                <tbody>
                  {cliRepPaginated.length === 0 ? (
                    <tr>
                      <td colSpan={9} style={{ padding: 24, textAlign: "center", color: SKY.muted2 }}>
                        No data in this date range — widen dates or add invoices.
                      </td>
                    </tr>
                  ) : (
                    cliRepPaginated.map(r => (
                      <tr
                        key={r.key}
                        style={{ borderBottom: `1px solid ${SKY.rowLine}` }}
                        onMouseEnter={e => (e.currentTarget.style.background = SKY.hover)}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                      >
                        <td style={{ padding: 8, fontWeight: 600, color: SKY.text, maxWidth: 200 }}>{r.client}</td>
                        <td style={{ padding: 8, whiteSpace: "nowrap" }}>{r.lastInvoiceDate}</td>
                        <td style={{ padding: 8, textAlign: "right" }}>{r.invCount}</td>
                        <td style={{ padding: 8, textAlign: "right", fontFamily: "monospace" }}>₹{inr(r.totalInvoiced)}</td>
                        <td style={{ padding: 8, textAlign: "right", fontFamily: "monospace", color: "#f59e0b" }}>₹{inr(r.pending)}</td>
                        <td style={{ padding: 8, textAlign: "right", fontFamily: "monospace" }}>₹{inr(r.netDue)}</td>
                        <td style={{ padding: 8, textAlign: "right", fontFamily: "monospace", fontSize: 10 }}>₹{inr(r.tdsSum)}</td>
                        <td style={{ padding: 8, textAlign: "right", fontFamily: "monospace", fontSize: 10 }}>₹{inr(r.gstSum)}</td>
                        <td style={{ padding: 8 }}>
                          {r.avgPayDays != null ? (
                            <span style={{ ...pillStyle("Director Payment", `${r.avgPayDays}d`), fontSize: 9 }}>Pays ~{r.avgPayDays}d</span>
                          ) : (
                            <span style={{ color: "#94a3b8" }}>—</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 10, lineHeight: 1.45 }}>
              Figures include only invoices with invoice date in the range above. <strong>Avg pay</strong> uses fully settled invoices (paid date vs invoice date). Credit limits are not tracked — columns for credit can be added when you maintain limits in books.
            </div>
          </>
        ) : null}

        {cliView === "ledger" ? (
          <div>
            <div style={{ marginBottom: 14, display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 10 }}>
              <div style={{ flex: "1 1 220px" }}>
                <label style={LB}>Select client</label>
                <select value={cliLedgerKey} onChange={e => setCliLedgerKey(e.target.value)} style={IS}>
                  <option value="">— Select client —</option>
                  {clientRows.map(row => (
                    <option key={row.key} value={row.key}>
                      {row.client}
                      {row.gstin ? ` · ${row.gstin}` : ""}
                    </option>
                  ))}
                </select>
              </div>
              {cliLedgerKey ? (
                <button
                  type="button"
                  disabled={acctRole === "Viewer"}
                  onClick={() => {
                    const row = clientRows.find(x => x.key === cliLedgerKey)
                    if (row) openEditClient(row)
                  }}
                  style={{ ...S.btnO, fontSize: 11, padding: "6px 12px", borderColor: `${JM.p}55`, color: JM.p, fontWeight: 700, opacity: acctRole === "Viewer" ? 0.45 : 1 }}
                >
                  Edit client
                </button>
              ) : null}
            </div>
            <div style={{ overflowX: "auto", borderRadius: 10, border: `1px solid ${SKY.border}`, background: SKY.surface }}>
              {renderClientLedgerPanel(clientRows.find(x => x.key === cliLedgerKey))}
            </div>
          </div>
        ) : null}

        {cliView === "clientwise" ? (
          <div>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 12, marginBottom: 14 }}>
              <div style={{ flex: "1 1 220px" }}>
                <label style={LB}>Select client</label>
                <select value={cliWiseKey} onChange={e => setCliWiseKey(e.target.value)} style={IS}>
                  <option value="">— Select client —</option>
                  {clientRows.map(row => (
                    <option key={row.key} value={row.key}>
                      {row.client}
                      {row.gstin ? ` · ${row.gstin}` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: SKY.muted, textTransform: "uppercase" }}>Date range</span>
                <input type="date" value={cliRepFrom} onChange={e => setCliRepFrom(e.target.value)} style={{ ...hdrInputLocal, width: 140 }} />
                <span style={{ fontSize: 11, color: "#94a3b8" }}>to</span>
                <input type="date" value={cliRepTo} onChange={e => setCliRepTo(e.target.value)} style={{ ...hdrInputLocal, width: 140 }} />
              </div>
              {cliWiseKey ? (
                <button
                  type="button"
                  disabled={acctRole === "Viewer"}
                  onClick={() => {
                    const row = clientRows.find(x => x.key === cliWiseKey)
                    if (row) openEditClient(row)
                  }}
                  style={{ ...S.btnO, fontSize: 11, padding: "6px 12px", borderColor: `${JM.p}55`, color: JM.p, fontWeight: 700, opacity: acctRole === "Viewer" ? 0.45 : 1 }}
                >
                  Edit client
                </button>
              ) : null}
            </div>
            {!cliWiseKey ? (
              <div style={{ padding: 20, textAlign: "center", color: SKY.muted2, fontSize: 12 }}>
                Choose a client to see totals and invoice lines for the selected date range.
              </div>
            ) : (
              <>
                <div style={{ ...S.g2, marginBottom: 14 }}>
                  <Stat
                    label="Total invoiced (range)"
                    value={clientWiseRow ? "₹" + inr(clientWiseRow.totalInvoiced) : "—"}
                    sub={clientWiseRow ? `${clientWiseRow.invCount} invoice(s)` : ""}
                    color="#0369a1"
                  />
                  <Stat
                    label="Pending (range)"
                    value={clientWiseRow ? "₹" + inr(clientWiseRow.pending) : "—"}
                    sub="Open balance"
                    color="#f59e0b"
                  />
                  <Stat
                    label="TDS (range)"
                    value={clientWiseRow ? "₹" + inr(clientWiseRow.tdsSum) : "—"}
                    sub="Recorded on bills"
                    color="#64748b"
                  />
                  <Stat
                    label="GST (range)"
                    value={clientWiseRow ? "₹" + inr(clientWiseRow.gstSum) : "—"}
                    sub="CGST+SGST+IGST"
                    color="#64748b"
                  />
                </div>
                {clientWiseRow?.avgPayDays != null ? (
                  <div style={{ fontSize: 11, color: SKY.muted, marginBottom: 12 }}>
                    Avg. days to pay (settled bills): <strong style={{ color: SKY.text }}>~{clientWiseRow.avgPayDays}d</strong>
                  </div>
                ) : null}
                <div style={{ fontSize: 10, fontWeight: 800, color: JM.p, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>Invoices in range</div>
                <div style={{ overflowX: "auto", borderRadius: 10, border: `1px solid ${SKY.border}`, background: SKY.surface }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                    <thead>
                      <tr style={{ background: SKY.surface2 }}>
                        <th style={{ padding: 8, textAlign: "left", fontSize: 10, fontWeight: 700, color: SKY.text2 }}>Date</th>
                        <th style={{ padding: 8, textAlign: "left", fontSize: 10, fontWeight: 700, color: SKY.text2 }}>Invoice</th>
                        <th style={{ padding: 8, textAlign: "right", fontSize: 10, fontWeight: 700, color: SKY.text2 }}>Total</th>
                        <th style={{ padding: 8, textAlign: "right", fontSize: 10, fontWeight: 700, color: SKY.text2 }}>Bank</th>
                        <th style={{ padding: 8, textAlign: "right", fontSize: 10, fontWeight: 700, color: SKY.text2 }}>Balance</th>
                        <th style={{ padding: 8, textAlign: "left", fontSize: 10, fontWeight: 700, color: SKY.text2 }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {clientWiseInvoices.length === 0 ? (
                        <tr>
                          <td colSpan={6} style={{ padding: 24, textAlign: "center", color: SKY.muted2 }}>
                            No invoices in this range for this client.
                          </td>
                        </tr>
                      ) : (
                        clientWiseInvoices.map(inv => {
                          const st = invoiceUiStatus(inv)
                          return (
                            <tr key={inv.id} style={{ borderBottom: `1px solid ${SKY.rowLine}` }}>
                              <td style={{ padding: 8, whiteSpace: "nowrap" }}>{formatIsoNice(inv.date)}</td>
                              <td style={{ padding: 8, fontWeight: 600 }}>{inv.num}</td>
                              <td style={{ padding: 8, textAlign: "right", fontFamily: "monospace" }}>₹{inr(inv.total)}</td>
                              <td style={{ padding: 8, textAlign: "right", fontFamily: "monospace", color: "#64748b" }}>₹{inr(invoiceBankReceived(inv))}</td>
                              <td style={{ padding: 8, textAlign: "right", fontFamily: "monospace", color: invoiceBalance(inv) > 0 ? "#f59e0b" : "#94a3b8" }}>₹{inr(invoiceBalance(inv))}</td>
                              <td style={{ padding: 8 }}>
                                <Chip cat={st === "paid" ? "Revenue" : st === "overdue" ? "Director Payment" : "Misc Expense"} label={st} />
                              </td>
                            </tr>
                          )
                        })
                      )}
                    </tbody>
                  </table>
                </div>
                <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 10, lineHeight: 1.45 }}>
                  Same methodology as the <strong>Client report</strong> tab, filtered to one client.
                </div>
              </>
            )}
          </div>
        ) : null}
      </div>
    )
  }

  const Led = () => {
    const data = ledFilteredData
    const tDr = data.filter(t => t.drCr === "DR").reduce((s, t) => s + t.amount, 0)
    const tCr = data.filter(t => t.drCr === "CR").reduce((s, t) => s + t.amount, 0)
    const gridCols = "88px 1fr 105px 105px 120px"
    return (
      <div>
        <div style={{ display: "flex", gap: 7, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
          <select value={ledAcc} onChange={e => setLedAcc(e.target.value)} style={{ ...S.sel, width: 220 }}>
            {["Primary bank account", "Service revenue", "Salaries & wages", "Directors remuneration", "Vendor payable", "Capital"].map(a => (
              <option key={a}>{a}</option>
            ))}
          </select>
          <input type="date" defaultValue="2025-01-01" style={{ ...IS, width: 130, height: 32 }} />
          <input type="date" defaultValue="2026-03-31" style={{ ...IS, width: 130, height: 32 }} />
        </div>
        <div style={{ background: "#ffffff", border: "1px solid #bae6fd", borderRadius: 10, overflow: "hidden" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: gridCols,
              gap: 8,
              padding: "8px 13px",
              background: "#ffffff",
              fontSize: 10,
              fontWeight: 700,
              color: "#64748b",
              borderBottom: "1px solid #bae6fd",
              textTransform: "uppercase",
              letterSpacing: ".4px",
            }}
          >
            <div>Date</div>
            <div>Narration</div>
            <div>Debit (₹)</div>
            <div>Credit (₹)</div>
            <div>Balance (₹)</div>
          </div>
          {ledVisibleRows.map(t => (
            <div
              key={t.id}
              style={{
                display: "grid",
                gridTemplateColumns: gridCols,
                gap: 8,
                padding: "7px 13px",
                borderBottom: "1px solid #e0f2fe",
                fontSize: 11.5,
                alignItems: "center",
              }}
            >
              <div style={{ color: "#64748b" }}>{t.date}</div>
              <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11 }}>{t.particulars.substring(0, 50)}</div>
              <div
                style={{
                  color: t.drCr === "DR" ? "#f43f5e" : "#bae6fd",
                  fontFamily: "monospace",
                  fontWeight: t.drCr === "DR" ? 700 : 400,
                }}
              >
                {t.drCr === "DR" ? "₹" + inr(t.amount) : "—"}
              </div>
              <div
                style={{
                  color: t.drCr === "CR" ? "#10b981" : "#bae6fd",
                  fontFamily: "monospace",
                  fontWeight: t.drCr === "CR" ? 700 : 400,
                }}
              >
                {t.drCr === "CR" ? "₹" + inr(t.amount) : "—"}
              </div>
              <div style={{ color: "#6B7AFF", fontFamily: "monospace", fontWeight: 600 }}>₹{inr(t.balance)}</div>
            </div>
          ))}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: gridCols,
              gap: 8,
              padding: "8px 13px",
              background: "#ffffff",
              fontSize: 12,
              fontWeight: 700,
              borderTop: "1px solid #bae6fd",
            }}
          >
            <div>TOTAL</div>
            <div />
            <div style={{ color: "#f43f5e", fontFamily: "monospace" }}>₹{inr(tDr)}</div>
            <div style={{ color: "#10b981", fontFamily: "monospace" }}>₹{inr(tCr)}</div>
            <div style={{ color: "#6B7AFF", fontFamily: "monospace" }}>
              ₹{inr(Math.abs(tCr - tDr))} {tCr >= tDr ? "Cr" : "Dr"}
            </div>
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
    const GST_PAY = "GST Payment (Output Tax)"
    const mon = {}
    reportLedger.forEach(t => {
      const p = t.date.split("/")
      const k = `${p[1]}/${p[2]}`
      if (!mon[k]) mon[k] = { cr: 0, gstPaid: 0, label: k }
      if (t.drCr === "CR") mon[k].cr += t.amount
      if (t.drCr === "DR" && t.category === GST_PAY) mon[k].gstPaid += t.amount
    })
    const sortMonthKeys = (a, b) => {
      const [ma, ya] = String(a).split("/").map(Number)
      const [mb, yb] = String(b).split("/").map(Number)
      return ya !== yb ? ya - yb : ma - mb
    }
    const rows = Object.entries(mon)
      .sort(([a], [b]) => sortMonthKeys(a, b))
      .filter(([, d]) => d.cr > 100 || d.gstPaid > 0.01)
      .map(([k, d]) => {
        const taxable = Math.round(d.cr / 1.18)
        const gst = Math.round(d.cr - taxable)
        const netAfterPay = Math.max(0, Math.round((gst - d.gstPaid) * 100) / 100)
        const filed = gst <= 1 || netAfterPay <= 0.5
        return {
          month: d.label,
          rev: d.cr,
          taxable,
          gst,
          gstPaid: d.gstPaid,
          net: netAfterPay,
          filed,
        }
      })
    const itVendorDr = reportLedger.filter(t => t.drCr === "DR" && t.category === "Vendor - IT Solutions")
    const itVendorGross = itVendorDr.reduce((s, t) => s + t.amount, 0)
    const itcItVendor = itVendorDr.reduce((s, t) => s + gst18InclusiveSplit(t.amount).gst, 0)
    const bankDr = reportLedger.filter(t => t.drCr === "DR" && t.category === "Bank Charges")
    const itcBank = bankDr.reduce((s, t) => s + gst18InclusiveSplit(t.amount).gst, 0)
    const totalItc = Math.round((itcItVendor + itcBank) * 100) / 100
    const itcCgstTot = Math.round((totalItc / 2) * 100) / 100
    const itcSgstTot = Math.round((totalItc - itcCgstTot) * 100) / 100
    const outputGstEst = outputGstFromRev
    const gstPaymentDr = reportLedger.filter(t => t.drCr === "DR" && t.category === GST_PAY)
    const totalGstPaid = Math.round(gstPaymentDr.reduce((s, t) => s + (Number(t.amount) || 0), 0) * 100) / 100
    const netAfterItc = Math.max(0, Math.round((outputGstEst - totalItc) * 100) / 100)
    const netPayGst = Math.max(0, Math.round((netAfterItc - totalGstPaid) * 100) / 100)
    const itcRowsIt = itVendorDr.map(t=>{
      const { taxable, gst, cgst, sgst } = gst18InclusiveSplit(t.amount)
      return { date:t.date, v:"IT Solutions", d:t.particulars.length>44?t.particulars.slice(0,42)+"…":t.particulars, a:"₹"+inr0(t.amount), tx:"₹"+inr0(taxable), g:"₹"+inr0(gst), cg:"₹"+inr0(cgst), sg:"₹"+inr0(sgst), sac:"99831x" }
    })
    const itcRowsBank = bankDr.map(t=>{
      const { taxable, gst, cgst, sgst } = gst18InclusiveSplit(t.amount)
      return { date:t.date, v:"Bank", d:t.particulars.length>44?t.particulars.slice(0,42)+"…":t.particulars, a:"₹"+inr0(t.amount), tx:"₹"+inr0(taxable), g:"₹"+inr0(gst), cg:"₹"+inr0(cgst), sg:"₹"+inr0(sgst), sac:"—" }
    })
    const itcRows = [...itcRowsIt,...itcRowsBank].sort((a,b)=>{ const pa=a.date.split("/"),pb=b.date.split("/"); return new Date(+pa[2],+pa[1]-1,+pa[0])-new Date(+pb[2],+pb[1]-1,+pb[0]) })
    const outCgst = Math.round(outputGstEst / 2)
    const outSgst = outputGstEst - outCgst
    const paidCgst = Math.round((totalGstPaid / 2) * 100) / 100
    const paidSgst = Math.round((totalGstPaid - paidCgst) * 100) / 100
    const netCgst = Math.max(0, Math.round((outCgst - itcCgstTot - paidCgst) * 100) / 100)
    const netSgst = Math.max(0, Math.round((outSgst - itcSgstTot - paidSgst) * 100) / 100)
    return (
      <div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(158px, 1fr))",
            gap: 11,
            marginBottom: 13,
          }}
        >
          <Stat label="Output GST (est.)" value={"₹" + inr0(outputGstEst)} sub="From Revenue @ 18%" color="#6B7AFF" />
          <Stat label="Input ITC (est.)" value={"₹" + inr0(totalItc)} sub={"IT ₹" + inr0(itcItVendor) + " · Bank ₹" + inr0(itcBank)} color="#10b981" />
          <Stat
            label="GST paid (ledger)"
            value={"₹" + inr0(totalGstPaid)}
            sub={gstPaymentDr.length ? `${gstPaymentDr.length} debit · ${GST_PAY}` : "Post via chat or txn"}
            color="#0d9488"
          />
          <Stat
            label="Net after ITC & paid"
            value={"₹" + inr0(netPayGst)}
            sub={totalGstPaid > 0 ? "Books snapshot — not filed return" : "Reduce when you record GST payments"}
            color="#f43f5e"
          />
          <Stat label="IT vendor (DR)" value={"₹" + inr0(itVendorGross)} sub={String(itVendorDr.length) + " payments"} color="#5563E8" />
        </div>
        <div
          style={{
            background: "rgba(14,165,233,.07)",
            border: "1px solid rgba(14,165,233,.25)",
            borderRadius: 9,
            padding: "10px 13px",
            marginBottom: 13,
            fontSize: 11.5,
            color: "#0369a1",
            lineHeight: 1.55,
          }}
        >
          <strong>How this ties to Transactions:</strong> Debits with category <strong>{GST_PAY}</strong> count as <strong>tax deposited from bank</strong> and reduce <strong>Net after ITC & paid</strong>. Monthly rows show GST paid in that calendar month. ITC splits are indicative @ 18% inclusive — reconcile with GSTR-2B / invoices.
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
          {[["mon", "Monthly"], ["g1", "GSTR-1"], ["g3b", "GSTR-3B"], ["itc", "ITC"]].map(([k, l]) => (
            <button key={k} type="button" onClick={() => setGTab(k)} style={S.tab(gTab === k)}>
              {l}
            </button>
          ))}
        </div>
        {gTab === "mon" && (
          <Tbl
            cols={[
              {
                h: "Month",
                cell: r => (
                  <span style={{ fontFamily: "monospace", fontWeight: 700 }}>{r.month}</span>
                ),
              },
              {
                h: "Receipt (₹)",
                r: true,
                cell: r => (
                  <span style={{ color: "#10b981", fontFamily: "monospace" }}>₹{inr0(r.rev)}</span>
                ),
              },
              { h: "Taxable (est.)", r: true, cell: r => "₹" + inr0(r.taxable) },
              {
                h: "Output GST",
                r: true,
                cell: r => (
                  <span style={{ color: "#6B7AFF", fontFamily: "monospace" }}>₹{inr0(r.gst)}</span>
                ),
              },
              {
                h: "GST paid",
                r: true,
                cell: r => (
                  <span style={{ color: "#0d9488", fontFamily: "monospace" }}>₹{inr0(r.gstPaid)}</span>
                ),
              },
              {
                h: "Net (month)",
                r: true,
                cell: r => (
                  <span style={{ color: "#f43f5e", fontFamily: "monospace", fontWeight: 700 }}>₹{inr0(r.net)}</span>
                ),
              },
              {
                h: "Status",
                cell: r => (
                  <Chip cat={r.filed ? "Revenue" : "Bank Charges"} label={r.filed ? "Covered" : "Open"} />
                ),
              },
            ]}
            rows={rows}
          />
        )}
        {gTab==="g1"&&<div style={S.card}><div style={{fontSize:12,fontWeight:700,marginBottom:12}}>GSTR-1 — Outward Supply Filing Guide</div><div style={S.g4}><Stat label="SAC Code" value="998314" sub="IT Services"/><Stat label="GST Rate" value="18%" sub="CGST+SGST"/><Stat label="Deadline" value="11th" sub="of each month"/><Stat label="Frequency" value="Monthly" sub="or QRMP &lt;₹5Cr"/></div><div style={{background:"rgba(107,122,255,.08)",border:"1px solid rgba(107,122,255,.2)",borderRadius:9,padding:"9px 13px",fontSize:11.5,color:"#0369a1"}}>Classify **B2B** NEFT/IMPS credits using the revenue categories in your ledger (e.g. B2B services @ 18%). Collect counterparty **GSTINs** and tax invoices before filing.</div><div style={{background:"rgba(107,122,255,.08)",border:"1px solid rgba(107,122,255,.2)",borderRadius:9,padding:"9px 13px",marginTop:12,fontSize:11.5,color:"#0369a1"}}><strong>Inward (purchases):</strong> Record vendor invoices (e.g. SAC **998313 / 998314** for IT services) as expenses; reconcile **ITC** in **GSTR-2B** with bank payments to those vendors.</div></div>}
        {gTab === "g3b" && (
          <div style={S.card}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 12 }}>GSTR-3B — estimated from ledger</div>
            <Tbl
              cols={[
                { h: "Head", k: "h" },
                { h: "Description", k: "d" },
                { h: "IGST", r: true, k: "i" },
                { h: "CGST", r: true, k: "c" },
                { h: "SGST", r: true, k: "s" },
              ]}
              rows={[
                { h: "3.1(a)", d: "Outward taxable (est.)", i: "₹0", c: "₹" + inr0(outCgst), s: "₹" + inr0(outSgst) },
                { h: "4.", d: "ITC (Vendor IT + Bank chg., est.)", i: "₹0", c: "₹" + inr0(itcCgstTot), s: "₹" + inr0(itcSgstTot) },
                {
                  h: "5.",
                  d: "GST paid from bank (ledger " + GST_PAY + ")",
                  i: "₹0",
                  c: "₹" + inr0(paidCgst),
                  s: "₹" + inr0(paidSgst),
                },
                { h: "6.", d: "Balance (est.) after ITC & payments", i: "₹0", c: "₹" + inr0(netCgst), s: "₹" + inr0(netSgst) },
              ]}
            />
          </div>
        )}
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
    const bankCashLines = reportLedger.filter(t => !t.void && !t.excludeFromBankRunning)
    const bankCrTot = bankCashLines.filter(t => t.drCr === "CR").reduce((s, t) => s + (Number(t.amount) || 0), 0)
    const bankDrTot = bankCashLines.filter(t => t.drCr === "DR").reduce((s, t) => s + (Number(t.amount) || 0), 0)
    const bankOnlyNet = Math.round((bankCrTot - bankDrTot) * 100) / 100
    const nonBankLines = reportLedger.filter(t => !t.void && t.excludeFromBankRunning)
    const nonBankCrTot = nonBankLines.filter(t => t.drCr === "CR").reduce((s, t) => s + (Number(t.amount) || 0), 0)
    const nonBankDrTot = nonBankLines.filter(t => t.drCr === "DR").reduce((s, t) => s + (Number(t.amount) || 0), 0)
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
              <div
                style={{
                  fontSize: 10,
                  color: "#0369a1",
                  marginBottom: 10,
                  lineHeight: 1.5,
                  textAlign: "left",
                  padding: "10px 12px",
                  background: "rgba(14,165,233,.08)",
                  border: "1px solid rgba(14,165,233,.25)",
                  borderRadius: 10,
                }}
              >
                <strong>Why two different numbers?</strong> The large figure is Σ (all credits) − Σ (all debits) across <strong>every</strong>{" "}
                booked line, including entries that do <strong>not</strong> move the bank (for example some TDS / invoice-only credits). The{" "}
                <strong>bank-only</strong> line uses only rows that affect the bank running balance. <strong>Closing bank</strong> comes from your
                statement / running-balance column (and opening balance, if any, in the chain).
              </div>
              <div style={{ fontSize: 11, color: "#64748b", marginBottom: 7 }}>
                Σ all credits − Σ all debits (every line, including non-bank journal entries)
              </div>
              <div style={{ fontSize: 32, fontWeight: 800, color: plNet >= 0 ? "#10b981" : "#f43f5e", fontFamily: "monospace" }}>
                {plNet >= 0 ? "+" : "-"} ₹{inr0(Math.abs(plNet))}
              </div>
              <div style={{ fontSize: 11, color: "#64748b", marginTop: 12, marginBottom: 6 }}>
                Σ credits − Σ debits, <strong>bank-affecting lines only</strong> (excludes <code style={{ fontSize: 9 }}>excludeFromBankRunning</code>)
              </div>
              <div style={{ fontSize: 22, fontWeight: 800, color: bankOnlyNet >= 0 ? "#10b981" : "#f43f5e", fontFamily: "monospace" }}>
                {bankOnlyNet >= 0 ? "+" : "-"} ₹{inr0(Math.abs(bankOnlyNet))}
              </div>
              {(nonBankCrTot > 0.005 || nonBankDrTot > 0.005) && (
                <div style={{ fontSize: 10, color: "#64748b", marginTop: 8, lineHeight: 1.45 }}>
                  Non-bank lines in this report: credits ₹{inr0(nonBankCrTot)} · debits ₹{inr0(nonBankDrTot)} — included in the first total above,
                  not in the bank-only net.
                </div>
              )}
              <div style={{ fontSize: 11, color: "#64748b", marginTop: 10 }}>Capital credited (financing): ₹{inr0(capitalCr)}</div>
              <div style={{ fontSize: 17, fontWeight: 800, color: "#6B7AFF", marginTop: 7, fontFamily: "monospace" }}>
                Closing bank (statement / running): ₹{inr0(bankBal)}
              </div>
              <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 10, lineHeight: 1.45 }}>
                To bulk-recategorise from narration: open <strong>AI Agent</strong> → <strong>Rules & templates</strong>, enable match rules, then click <strong>Run rules on full ledger</strong>.
                Nothing runs unless you turn rules on and run that action.
              </div>
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
      case "clients": return <Clients/>
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
            welcomeName={activeCompany?.name || "your company"}
            automationSkills={automationSkills}
            setAutomationSkills={setAutomationSkills}
            onRunAutomation={runAutomationOnLedger}
            onPostTemplate={postAutomationTemplate}
            cats={CATS}
            onBankStatementFile={handleBankStatementFile}
            onOpenInvoiceModal={openCreateInvoiceModal}
            ledgerTxns={ledger}
            onRecategorizeTxn={updateTxnCategoryFromMisc}
            assistantMemory={assistantMemory}
            onAssistantMemoryAdd={addAssistantMemoryNote}
            onRemoveAssistantNote={removeAssistantNote}
            onAutomationRuleConfirm={confirmAutomationRuleFromChat}
            onBulkSalaryPosted={n => toast_(`Posted ${n} salary line(s) to ledger`, "#10b981")}
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
              <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #e0f2fe" }}>
                <div style={{ fontSize: 11, color: "#64748b", marginBottom: 8, lineHeight: 1.5 }}>
                  Start fresh: opens a confirmation dialog, then deletes every row created from a bank file (tagged{" "}
                  <code style={{ fontSize: 10 }}>import:…</code>). Manual entries and invoice postings stay. Import history is cleared.
                </div>
                <button
                  type="button"
                  disabled={acctRole === "Viewer"}
                  onClick={requestRemoveBankImportTransactions}
                  style={{
                    ...S.btnO,
                    fontSize: 11,
                    color: "#f43f5e",
                    borderColor: "rgba(244,63,94,.45)",
                    opacity: acctRole === "Viewer" ? 0.45 : 1,
                    cursor: acctRole === "Viewer" ? "default" : "pointer",
                  }}
                >
                  {acctRole === "Viewer" ? "View-only" : "Remove all bank-import transactions"}
                </button>
              </div>
            </div>
            <div style={S.card}>
              <div style={{fontSize:12,fontWeight:700,marginBottom:12}}>⚡ How It Works</div>
              {["Upload CSV/XLSX from your bank portal","Importer suggests categories from narration (edit in Transactions if needed)","Review before relying on reports","Import adds tagged rows you can bulk-remove here"].map((s,i)=>(
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
          <div
            style={{ fontSize: 17, fontWeight: 800, color: "#0c4a6e", marginTop: 2, fontFamily: "monospace", letterSpacing: -1 }}
            title="Same as Chart of Accounts — Primary bank account (net Dr from posted journals). May differ from the last row’s imported statement balance."
          >
            ₹{inr0(bookBankBalance)}
          </div>
          <div style={{ fontSize: 9, color: "#475569", marginTop: 2, lineHeight: 1.35 }} title="Set under Companies">
            {activeCompany?.bankAccountLabel || "Bank label · set in Companies"}
          </div>
        </div>
        <nav style={{ flex: 1, overflowY: "auto", padding: "3px 9px" }}>
          <div style={{ marginBottom: 4, paddingBottom: 8, borderBottom: `1px solid ${SKY.borderHi}` }}>
            <button
              type="button"
              aria-expanded={navOpen.overview}
              onClick={() => setNavOpen(o => ({ ...o, overview: !o.overview }))}
              style={navSectionToggleBtn}
              onMouseEnter={e => {
                e.currentTarget.style.background = JM.r(0.08)
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = "transparent"
              }}
            >
              <span>Overview</span>
              <span style={{ fontSize: 10, opacity: 0.65, fontWeight: 800 }} aria-hidden>
                {navOpen.overview ? "▼" : "▶"}
              </span>
            </button>
            {navOpen.overview
              ? overviewNavLinks.map(([ic, k]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => {
                      setPage(k)
                      setFCat("")
                      setSearch("")
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "7px 10px",
                      paddingLeft: 12,
                      borderRadius: 8,
                      cursor: "pointer",
                      width: "100%",
                      textAlign: "left",
                      fontSize: 12,
                      fontWeight: 500,
                      border: "none",
                      background: page === k ? JM.r(0.16) : "transparent",
                      color: page === k ? JM.soft : "#94a3b8",
                      position: "relative",
                    }}
                  >
                    <span style={{ opacity: page === k ? 1 : 0.6, fontSize: ic === "🧾" ? 13 : 12, width: 16, textAlign: "center", flexShrink: 0, lineHeight: 1.2 }}>{ic}</span>
                  <span>{pages[k]}</span>
                    {page === k && (
                      <div style={{ position: "absolute", left: 0, top: "25%", bottom: "25%", width: 3, background: JM.p, borderRadius: "0 3px 3px 0" }} />
                    )}
                </button>
                ))
              : null}
            </div>
          <div style={{ marginBottom: 4, paddingBottom: 8, borderBottom: `1px solid ${SKY.borderHi}` }}>
            <button
              type="button"
              aria-expanded={navOpen.Finance}
              onClick={() => setNavOpen(o => ({ ...o, Finance: !o.Finance }))}
              style={navSectionToggleBtn}
              onMouseEnter={e => {
                e.currentTarget.style.background = JM.r(0.08)
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = "transparent"
              }}
            >
              <span>Finance</span>
              <span style={{ fontSize: 10, opacity: 0.65, fontWeight: 800 }} aria-hidden>
                {navOpen.Finance ? "▼" : "▶"}
              </span>
            </button>
            {navOpen.Finance
              ? financeNavLinks.map(([ic, k]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => {
                      setPage(k)
                      setFCat("")
                      setSearch("")
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "7px 10px",
                      paddingLeft: 12,
                      borderRadius: 8,
                      cursor: "pointer",
                      width: "100%",
                      textAlign: "left",
                      fontSize: 12,
                      fontWeight: 500,
                      border: "none",
                      background: page === k ? JM.r(0.16) : "transparent",
                      color: page === k ? JM.soft : "#94a3b8",
                      position: "relative",
                    }}
                  >
                    <span style={{ opacity: page === k ? 1 : 0.6, fontSize: 12, width: 14, textAlign: "center" }}>{ic}</span>
                    <span>{pages[k]}</span>
                    {k === "gst" && (
                      <span style={{ marginLeft: "auto", background: "#f43f5e", color: "#fff", borderRadius: 20, fontSize: 8, fontWeight: 700, padding: "1px 5px" }}>!</span>
                    )}
                    {page === k && (
                      <div style={{ position: "absolute", left: 0, top: "25%", bottom: "25%", width: 3, background: JM.p, borderRadius: "0 3px 3px 0" }} />
                    )}
                  </button>
                ))
              : null}
          </div>
          <div style={{ marginBottom: 4 }}>
            <button
              type="button"
              aria-expanded={navOpen.Intelligence}
              onClick={() => setNavOpen(o => ({ ...o, Intelligence: !o.Intelligence }))}
              style={navSectionToggleBtn}
              onMouseEnter={e => {
                e.currentTarget.style.background = JM.r(0.08)
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = "transparent"
              }}
            >
              <span>Intelligence</span>
              <span style={{ fontSize: 10, opacity: 0.65, fontWeight: 800 }} aria-hidden>
                {navOpen.Intelligence ? "▼" : "▶"}
              </span>
            </button>
            {navOpen.Intelligence
              ? intelNavLinks.map(([ic, k]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => {
                      setPage(k)
                      setFCat("")
                      setSearch("")
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "7px 10px",
                      paddingLeft: 12,
                      borderRadius: 8,
                      cursor: "pointer",
                      width: "100%",
                      textAlign: "left",
                      fontSize: 12,
                      fontWeight: 500,
                      border: "none",
                      background: page === k ? JM.r(0.16) : "transparent",
                      color: page === k ? JM.soft : "#94a3b8",
                      position: "relative",
                    }}
                  >
                    <span style={{ opacity: page === k ? 1 : 0.6, fontSize: 12, width: 14, textAlign: "center" }}>{ic}</span>
                    <span>{pages[k]}</span>
                    {page === k && (
                      <div style={{ position: "absolute", left: 0, top: "25%", bottom: "25%", width: 3, background: JM.p, borderRadius: "0 3px 3px 0" }} />
                    )}
                  </button>
                ))
              : null}
          </div>
        </nav>
        <div style={{ padding: "10px 12px", borderTop: `1px solid ${SKY.borderHi}`, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#0c4a6e" }}>
                {acctRole}{" "}
                <span
                  style={{
                    fontSize: 8,
                    background: JM.r(0.2),
                    color: JM.soft,
                    padding: "1px 6px",
                    borderRadius: 20,
                    fontWeight: 700,
                  }}
                >
                  {acctRole}
                </span>
              </div>
              <div style={{ fontSize: 9, color: "#475569", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={authUser.email}>
                {authUser.email}
              </div>
              <div style={{ fontSize: 9, color: "#475569" }}>{repFy ? formatFyLabel(repFy) : "All FYs"}</div>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <button
              type="button"
              onClick={() => setModal("settings")}
              style={{
                ...S.btnO,
                width: "100%",
                justifyContent: "center",
                fontSize: 11,
                color: "#0369a1",
              }}
            >
              Settings
            </button>
            <button
              type="button"
              onClick={() => {
                if (window.confirm("Log out? Your data stays saved on this device for this account.")) onLogout()
              }}
              style={{
                ...S.btnO,
                width: "100%",
                justifyContent: "center",
                fontSize: 11,
                color: "#64748b",
              }}
            >
              Log out
            </button>
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
              <div ref={quickAddRef} style={{ position: "relative" }}>
                <button
                  type="button"
                  onClick={() => {
                    if (acctRole === "Viewer") return
                    setQuickAddOpen(o => !o)
                  }}
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
                  {acctRole === "Viewer" ? "View-only" : "+ Add ▾"}
                </button>
                {quickAddOpen && acctRole !== "Viewer" ? (
                  <div
                    role="menu"
                    aria-label="Add menu"
                    style={{
                      position: "absolute",
                      right: 0,
                      top: "100%",
                      marginTop: 6,
                      width: 224,
                      background: SKY.surface2,
                      border: `1px solid ${SKY.borderHi}`,
                      borderRadius: 8,
                      boxShadow: "0 12px 32px rgba(15,23,42,.14)",
                      zIndex: 80,
                      padding: "4px 6px 8px",
                      maxHeight: "min(72vh, 440px)",
                      overflowY: "auto",
                    }}
                  >
                    <div style={{ fontSize: 9, color: "#475569", padding: "8px 10px 4px", letterSpacing: "1px", textTransform: "uppercase", fontWeight: 700 }}>Add</div>
                    {quickAddMenuGroups.map(grp => (
                      <div key={grp.key}>
                        <button
                          type="button"
                          aria-expanded={quickAddMenuOpen[grp.key]}
                          onClick={() => setQuickAddMenuOpen(o => ({ ...o, [grp.key]: !o[grp.key] }))}
                          style={navSectionToggleBtn}
                          onMouseEnter={e => {
                            e.currentTarget.style.background = JM.r(0.08)
                          }}
                          onMouseLeave={e => {
                            e.currentTarget.style.background = "transparent"
                          }}
                        >
                          <span>{grp.label}</span>
                          <span style={{ fontSize: 10, opacity: 0.65, fontWeight: 800 }} aria-hidden>
                            {quickAddMenuOpen[grp.key] ? "▼" : "▶"}
                          </span>
                        </button>
                        {quickAddMenuOpen[grp.key] ? quickAddItems.filter(i => grp.itemIds.includes(i.id)).map(renderQuickAddRow) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
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
        open={modal === "addClient"}
        title={editManualClientId != null || editClientPresetKey != null ? "Edit client" : "Add client"}
        wide
        onClose={() => {
          setModal(null)
          setEditManualClientId(null)
          setEditClientPresetKey(null)
        }}
        onSave={saveAddClientFromModal}
        saveDisabled={acctRole === "Viewer"}
        saveLabel={
          acctRole === "Viewer" ? "View-only" : editManualClientId != null || editClientPresetKey != null ? "Save changes" : "Save client"
        }
      >
        <div style={{ fontSize: 11, color: "#94a3b8", lineHeight: 1.55, marginBottom: 16 }}>
          {editManualClientId != null || editClientPresetKey != null ? (
            <>
              Update saved details for this client. If they have invoices, changing <strong style={{ color: SKY.text2 }}>company name</strong> or{" "}
              <strong style={{ color: SKY.text2 }}>GSTIN</strong> updates all matching invoices.
            </>
          ) : (
            <>
              Stored in your client directory for this workspace. When you create an invoice, choose this client from the saved list — no need to re-type details.
            </>
          )}
        </div>

        <div style={{ fontSize: 13, fontWeight: 800, color: SKY.text, marginBottom: 12 }}>Basic information</div>

        <div style={{ marginBottom: 12 }}>
          <input
            type="file"
            accept="image/jpeg,image/png"
            id="addClientLogo"
            style={{ display: "none" }}
            onChange={onAddClientLogoFile}
          />
          <div
            role="button"
            tabIndex={0}
            onKeyDown={e => {
              if (e.key === "Enter" || e.key === " ") document.getElementById("addClientLogo")?.click()
            }}
            onClick={() => document.getElementById("addClientLogo")?.click()}
            style={{
              border: `1px dashed ${SKY.borderHi}`,
              borderRadius: 10,
              padding: addClientDraft.logoDataUrl ? 16 : 28,
              textAlign: "center",
              background: SKY.surface2,
              cursor: "pointer",
              minHeight: addClientDraft.logoDataUrl ? 0 : 100,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {addClientDraft.logoDataUrl ? (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                <img
                  src={addClientDraft.logoDataUrl}
                  alt=""
                  style={{ maxWidth: 120, maxHeight: 120, borderRadius: 8, objectFit: "contain" }}
                />
                <button
                  type="button"
                  onClick={ev => {
                    ev.stopPropagation()
                    setAddClientDraft(p => ({ ...p, logoDataUrl: "" }))
                    const el = document.getElementById("addClientLogo")
                    if (el) el.value = ""
                  }}
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: "#f43f5e",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                  }}
                >
                  Remove logo
                </button>
              </div>
            ) : (
              <>
                <div style={{ fontSize: 24, color: SKY.muted, lineHeight: 1 }}>+</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: SKY.text2, marginTop: 6 }}>Upload logo</div>
              </>
            )}
          </div>
          <div style={{ fontSize: 10, color: SKY.muted, marginTop: 8, lineHeight: 1.45 }}>
            JPG or PNG, dimensions up to 1080×1080px and file size up to 20MB. Large logos are capped for browser storage (~300KB).
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px", alignItems: "start" }}>
          <F label="Business name*">
            <input
              value={addClientDraft.client}
              onChange={e => setAddClientDraft(p => ({ ...p, client: e.target.value }))}
              placeholder="Business name (required)"
              style={IS}
            />
          </F>
          <F label="Client industry">
            <select
              value={addClientDraft.clientIndustry}
              onChange={e => setAddClientDraft(p => ({ ...p, clientIndustry: e.target.value }))}
              style={IS}
            >
              <option value="">— Select an industry —</option>
              <option value="IT Services">IT Services</option>
              <option value="Manufacturing">Manufacturing</option>
              <option value="Retail">Retail</option>
              <option value="Consulting">Consulting</option>
              <option value="Healthcare">Healthcare</option>
              <option value="Education">Education</option>
              <option value="Other">Other</option>
            </select>
          </F>
          <F label="Select country*">
            <select
              value={addClientDraft.country}
              onChange={e => setAddClientDraft(p => ({ ...p, country: e.target.value }))}
              style={IS}
            >
              <option value="India">India</option>
              <option value="United States">United States</option>
              <option value="United Kingdom">United Kingdom</option>
              <option value="Singapore">Singapore</option>
              <option value="UAE">UAE</option>
              <option value="Other">Other</option>
            </select>
          </F>
          <F label="City / town">
            <input
              value={addClientDraft.city}
              onChange={e => setAddClientDraft(p => ({ ...p, city: e.target.value }))}
              placeholder="City / town name"
              style={IS}
            />
          </F>
        </div>

        <AddClientAccordion
          title="Tax information"
          optional
          open={addClientSec.tax}
          onToggle={() => setAddClientSec(s => ({ ...s, tax: !s.tax }))}
        >
          <F label="GSTIN">
            <input
              value={addClientDraft.gstin}
              onChange={e => setAddClientDraft(p => ({ ...p, gstin: e.target.value }))}
              placeholder="29AAAC…"
              style={IS}
            />
          </F>
          <F label="PAN">
            <input
              value={addClientDraft.pan}
              onChange={e => setAddClientDraft(p => ({ ...p, pan: e.target.value }))}
              placeholder="PAN (optional)"
              style={IS}
            />
          </F>
          <F label="Place of supply">
            <select value={addClientDraft.place} onChange={e => setAddClientDraft(p => ({ ...p, place: e.target.value }))} style={IS}>
              <option value="intra">Intra-state (CGST + SGST)</option>
              <option value="inter">Inter-state (IGST)</option>
            </select>
          </F>
        </AddClientAccordion>

        <AddClientAccordion
          title="Address"
          optional
          open={addClientSec.address}
          onToggle={() => setAddClientSec(s => ({ ...s, address: !s.address }))}
        >
          <F label="Address line 1">
            <input
              value={addClientDraft.addrLine1}
              onChange={e => setAddClientDraft(p => ({ ...p, addrLine1: e.target.value }))}
              placeholder="Street, building"
              style={IS}
            />
          </F>
          <F label="Address line 2">
            <input
              value={addClientDraft.addrLine2}
              onChange={e => setAddClientDraft(p => ({ ...p, addrLine2: e.target.value }))}
              placeholder="Area, landmark"
              style={IS}
            />
          </F>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
            <F label="State">
              <input
                value={addClientDraft.state}
                onChange={e => setAddClientDraft(p => ({ ...p, state: e.target.value }))}
                placeholder="State"
                style={IS}
              />
            </F>
            <F label="PIN / ZIP">
              <input
                value={addClientDraft.pin}
                onChange={e => setAddClientDraft(p => ({ ...p, pin: e.target.value }))}
                placeholder="PIN / ZIP"
                style={IS}
              />
            </F>
          </div>
        </AddClientAccordion>

        <AddClientAccordion
          title="Shipping details"
          optional
          open={addClientSec.shipping}
          onToggle={() => setAddClientSec(s => ({ ...s, shipping: !s.shipping }))}
        >
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, fontSize: 12, color: SKY.text2, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={addClientDraft.shipSame}
              onChange={e => setAddClientDraft(p => ({ ...p, shipSame: e.target.checked }))}
            />
            Same as billing address
          </label>
          {!addClientDraft.shipSame ? (
            <>
              <F label="Shipping line 1">
                <input
                  value={addClientDraft.shipLine1}
                  onChange={e => setAddClientDraft(p => ({ ...p, shipLine1: e.target.value }))}
                  placeholder="Ship-to address"
                  style={IS}
                />
              </F>
              <F label="Shipping line 2">
                <input
                  value={addClientDraft.shipLine2}
                  onChange={e => setAddClientDraft(p => ({ ...p, shipLine2: e.target.value }))}
                  style={IS}
                />
              </F>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
                <F label="State">
                  <input
                    value={addClientDraft.shipState}
                    onChange={e => setAddClientDraft(p => ({ ...p, shipState: e.target.value }))}
                    style={IS}
                  />
                </F>
                <F label="PIN / ZIP">
                  <input
                    value={addClientDraft.shipPin}
                    onChange={e => setAddClientDraft(p => ({ ...p, shipPin: e.target.value }))}
                    style={IS}
                  />
                </F>
              </div>
            </>
          ) : null}
        </AddClientAccordion>

        <AddClientAccordion
          title="Additional details"
          optional
          open={addClientSec.additional}
          onToggle={() => setAddClientSec(s => ({ ...s, additional: !s.additional }))}
        >
          <F label="Notes">
            <textarea
              value={addClientDraft.additionalNotes}
              onChange={e => setAddClientDraft(p => ({ ...p, additionalNotes: e.target.value }))}
              placeholder="Internal notes, payment terms, etc."
              rows={3}
              style={{ ...IS, resize: "vertical", minHeight: 72 }}
            />
          </F>
          <F label="Credit limit">
            <input
              value={addClientDraft.creditLimit}
              onChange={e => setAddClientDraft(p => ({ ...p, creditLimit: e.target.value }))}
              placeholder="Optional"
              style={IS}
            />
          </F>
        </AddClientAccordion>

        <AddClientAccordion
          title="Attachments"
          optional
          open={addClientSec.attachments}
          onToggle={() => setAddClientSec(s => ({ ...s, attachments: !s.attachments }))}
        >
          <div style={{ fontSize: 12, color: SKY.muted, lineHeight: 1.5 }}>
            File attachments linked to the client record are not stored in this build. Use your drive or email for contracts; we may add uploads in a future release.
          </div>
        </AddClientAccordion>

        <AddClientAccordion
          title="Account details"
          optional
          open={addClientSec.account}
          onToggle={() => setAddClientSec(s => ({ ...s, account: !s.account }))}
        >
          <F label="Bank name">
            <input
              value={addClientDraft.bankName}
              onChange={e => setAddClientDraft(p => ({ ...p, bankName: e.target.value }))}
              style={IS}
            />
          </F>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
            <F label="Account number">
              <input
                value={addClientDraft.accountNumber}
                onChange={e => setAddClientDraft(p => ({ ...p, accountNumber: e.target.value }))}
                style={IS}
              />
            </F>
            <F label="IFSC / SWIFT">
              <input
                value={addClientDraft.ifsc}
                onChange={e => setAddClientDraft(p => ({ ...p, ifsc: e.target.value }))}
                style={IS}
              />
            </F>
          </div>
        </AddClientAccordion>
      </Modal>

      <Modal
        open={modal === "settings"}
        title="Settings"
        wide
        onClose={() => setModal(null)}
        onSave={savePasswordFromSettings}
        saveDisabled={settingsSaving || acctRole === "Viewer"}
        saveLabel={acctRole === "Viewer" ? "View-only" : settingsSaving ? "Saving..." : "Change password"}
      >
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div style={{ background: SKY.surface, border: `1px solid ${SKY.border}`, borderRadius: 10, padding: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: SKY.text2, marginBottom: 10 }}>User profile</div>
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4 }}>Email</div>
            <div style={{ fontSize: 12, color: "#0c4a6e", fontWeight: 700, marginBottom: 10 }}>{authUser.email}</div>
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4 }}>Role</div>
            <div style={{ fontSize: 12, color: "#0c4a6e", fontWeight: 700, marginBottom: 10 }}>{acctRole}</div>
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4 }}>Active FY</div>
            <div style={{ fontSize: 12, color: "#0c4a6e", fontWeight: 700 }}>{repFy ? formatFyLabel(repFy) : "All FYs"}</div>
          </div>

          <div style={{ background: SKY.surface, border: `1px solid ${SKY.border}`, borderRadius: 10, padding: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: SKY.text2, marginBottom: 10 }}>Company settings</div>
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4 }}>Active company</div>
            <div style={{ fontSize: 12, color: "#0c4a6e", fontWeight: 700, marginBottom: 10 }}>
              {activeCompany?.name || "Company"}
            </div>
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 12 }}>
              Update legal name, GSTIN, address, bank details, logo and invoice footer from Companies.
            </div>
            <button
              type="button"
              onClick={() => setModal("companies")}
              style={{ ...S.btnO, fontSize: 11, color: "#0369a1", borderColor: "#7dd3fc" }}
            >
              Open company settings
            </button>
          </div>
        </div>

        <div style={{ marginTop: 14, background: "#ffffff", border: `1px solid ${SKY.border}`, borderRadius: 10, padding: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: SKY.text2, marginBottom: 10 }}>Change password</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <F label="Current password">
              <input
                type="password"
                value={settingsPwd.current}
                onChange={e => setSettingsPwd(p => ({ ...p, current: e.target.value }))}
                style={IS}
                placeholder="Enter current password"
              />
            </F>
            <div />
            <F label="New password">
              <input
                type="password"
                value={settingsPwd.next}
                onChange={e => setSettingsPwd(p => ({ ...p, next: e.target.value }))}
                style={IS}
                placeholder="Minimum 8 characters"
              />
            </F>
            <F label="Confirm new password">
              <input
                type="password"
                value={settingsPwd.confirm}
                onChange={e => setSettingsPwd(p => ({ ...p, confirm: e.target.value }))}
                style={IS}
                placeholder="Re-enter new password"
              />
            </F>
          </div>
        </div>
      </Modal>

      <Modal
        open={modal === "companies"}
        title="Companies & workspaces"
        wide
        onClose={() => setModal(null)}
        onSave={async () => {
          if (!activeCompanyId || acctRole === "Viewer") return
          await saveCompanyProfile(activeCompanyId, {
            name: coDraft.name.trim() || "Company",
            legalName: coDraft.legalName.trim(),
            bankAccountLabel: coDraft.bankAccountLabel.trim(),
            logoDataUrl: typeof coDraft.logoDataUrl === "string" ? coDraft.logoDataUrl : "",
            addrLine1: coDraft.addrLine1.trim(),
            addrLine2: coDraft.addrLine2.trim(),
            city: coDraft.city.trim(),
            state: coDraft.state.trim(),
            country: coDraft.country.trim() || "India",
            pin: coDraft.pin.trim(),
            gstin: coDraft.gstin.trim(),
            pan: coDraft.pan.trim(),
            currency: coDraft.currency.trim() || "INR",
            invoiceSeriesPrefix: normalizeInvoiceSeriesPrefix(coDraft.invoiceSeriesPrefix),
            bankName: coDraft.bankName.trim(),
            bankAccountName: coDraft.bankAccountName.trim(),
            bankAccountNumber: coDraft.bankAccountNumber.trim(),
            bankIfsc: coDraft.bankIfsc.trim(),
            bankAccountType: coDraft.bankAccountType.trim(),
            invoiceFooterEmail: coDraft.invoiceFooterEmail.trim(),
            invoiceFooterPhone: coDraft.invoiceFooterPhone.trim(),
          })
          setModal(null)
        }}
        saveDisabled={acctRole === "Viewer"}
        saveLabel={acctRole === "Viewer" ? "View-only" : "Save company"}
      >
        <div style={{ fontSize: 11, color: "#94a3b8", lineHeight: 1.55, marginBottom: 14 }}>
          Each company keeps its own ledger, invoices, bank imports, and audit trail. Fill <strong style={{ color: SKY.text2 }}>company details</strong> below so your logo, address, GSTIN, PAN, and <strong style={{ color: SKY.text2 }}>bank details</strong> appear in the <strong style={{ color: SKY.text2 }}>Billed by</strong> block on printed invoices.
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
        <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", marginBottom: 8 }}>ACTIVE COMPANY — INVOICE & PROFILE</div>
        <div style={{ fontSize: 11, color: SKY.muted, marginBottom: 12 }}>
          Shown on invoices as <strong style={{ color: SKY.text2 }}>Billed by</strong> (legal name, address, tax IDs). Display name stays in the app header.
        </div>
        <input type="file" accept="image/jpeg,image/png" id="companyLogoIn" style={{ display: "none" }} onChange={onCompanyLogoFile} />
        <div
          role="button"
          tabIndex={0}
          onKeyDown={e => {
            if (e.key === "Enter" || e.key === " ") document.getElementById("companyLogoIn")?.click()
          }}
          onClick={() => document.getElementById("companyLogoIn")?.click()}
          style={{
            border: `1px dashed ${SKY.borderHi}`,
            borderRadius: 10,
            padding: coDraft.logoDataUrl ? 12 : 20,
            textAlign: "center",
            background: SKY.surface2,
            cursor: acctRole === "Viewer" ? "default" : "pointer",
            marginBottom: 12,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            opacity: acctRole === "Viewer" ? 0.75 : 1,
          }}
        >
          {coDraft.logoDataUrl ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
              <img src={coDraft.logoDataUrl} alt="" style={{ maxWidth: 140, maxHeight: 56, objectFit: "contain" }} />
              {acctRole !== "Viewer" ? (
                <button
                  type="button"
                  onClick={ev => {
                    ev.stopPropagation()
                    setCoDraft(p => ({ ...p, logoDataUrl: "" }))
                    const el = document.getElementById("companyLogoIn")
                    if (el) el.value = ""
                  }}
                  style={{ fontSize: 11, fontWeight: 600, color: "#f43f5e", background: "none", border: "none", cursor: "pointer" }}
                >
                  Remove logo
                </button>
              ) : null}
            </div>
          ) : (
            <>
              <div style={{ fontSize: 22, color: SKY.muted }}>+</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: SKY.text2 }}>Company logo (invoice PDF)</div>
            </>
          )}
        </div>
        <div style={{ fontSize: 10, color: SKY.muted, marginBottom: 14 }}>JPG or PNG, up to 1080×1080px, ~300KB recommended for sync.</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
          <F label="Display name (header)">
            <input
              value={coDraft.name}
              onChange={e => setCoDraft(p => ({ ...p, name: e.target.value }))}
              style={IS}
              disabled={acctRole === "Viewer"}
            />
          </F>
          <F label="Legal name (invoice)">
            <input
              value={coDraft.legalName}
              onChange={e => setCoDraft(p => ({ ...p, legalName: e.target.value }))}
              style={IS}
              disabled={acctRole === "Viewer"}
              placeholder="As on GST / MCA / contract"
            />
          </F>
        </div>
        <F label="Registered address — line 1">
          <input
            value={coDraft.addrLine1}
            onChange={e => setCoDraft(p => ({ ...p, addrLine1: e.target.value }))}
            style={IS}
            disabled={acctRole === "Viewer"}
            placeholder="Street, building"
          />
        </F>
        <F label="Registered address — line 2">
          <input
            value={coDraft.addrLine2}
            onChange={e => setCoDraft(p => ({ ...p, addrLine2: e.target.value }))}
            style={IS}
            disabled={acctRole === "Viewer"}
            placeholder="Area, landmark"
          />
        </F>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
          <F label="City / town">
            <input
              value={coDraft.city}
              onChange={e => setCoDraft(p => ({ ...p, city: e.target.value }))}
              style={IS}
              disabled={acctRole === "Viewer"}
            />
          </F>
          <F label="State">
            <input
              value={coDraft.state}
              onChange={e => setCoDraft(p => ({ ...p, state: e.target.value }))}
              style={IS}
              disabled={acctRole === "Viewer"}
            />
          </F>
          <F label="Country">
            <input
              value={coDraft.country}
              onChange={e => setCoDraft(p => ({ ...p, country: e.target.value }))}
              style={IS}
              disabled={acctRole === "Viewer"}
            />
          </F>
          <F label="PIN / ZIP">
            <input
              value={coDraft.pin}
              onChange={e => setCoDraft(p => ({ ...p, pin: e.target.value }))}
              style={IS}
              disabled={acctRole === "Viewer"}
            />
          </F>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
          <F label="Company GSTIN">
            <input
              value={coDraft.gstin}
              onChange={e => setCoDraft(p => ({ ...p, gstin: e.target.value }))}
              style={IS}
              disabled={acctRole === "Viewer"}
              placeholder="Your GSTIN"
            />
          </F>
          <F label="Company PAN">
            <input
              value={coDraft.pan}
              onChange={e => setCoDraft(p => ({ ...p, pan: e.target.value }))}
              style={IS}
              disabled={acctRole === "Viewer"}
              placeholder="Your PAN"
            />
          </F>
        </div>
        <F label="Default invoice currency (label)">
          <select
            value={coDraft.currency}
            onChange={e => setCoDraft(p => ({ ...p, currency: e.target.value }))}
            style={IS}
            disabled={acctRole === "Viewer"}
          >
            <option value="INR">INR (₹)</option>
            <option value="USD">USD ($)</option>
            <option value="EUR">EUR (€)</option>
            <option value="GBP">GBP (£)</option>
            <option value="AED">AED</option>
          </select>
        </F>
        <F label="Invoice number series (prefix)">
          <input
            value={coDraft.invoiceSeriesPrefix}
            onChange={e => setCoDraft(p => ({ ...p, invoiceSeriesPrefix: e.target.value }))}
            style={IS}
            disabled={acctRole === "Viewer"}
            placeholder="JM-2026-"
          />
        </F>
        <div style={{ fontSize: 10, color: SKY.muted, marginTop: -6, marginBottom: 10, lineHeight: 1.45 }}>
          Type the full literal prefix before the digits (include hyphens), e.g. <strong style={{ color: SKY.text2 }}>JM-2026-</strong> →{" "}
          <strong style={{ color: SKY.text2 }}>JM-2026-0001</strong>, <strong style={{ color: SKY.text2 }}>JM-2026-0002</strong>. Default{" "}
          <strong style={{ color: SKY.text2 }}>INV-</strong> gives <strong style={{ color: SKY.text2 }}>INV-0001</strong>. You can still edit any invoice #.
        </div>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", marginBottom: 8, marginTop: 6 }}>INVOICE FOOTER (PRINTED)</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
          <F label="Enquiry email (footer line)">
            <input
              value={coDraft.invoiceFooterEmail}
              onChange={e => setCoDraft(p => ({ ...p, invoiceFooterEmail: e.target.value }))}
              style={IS}
              disabled={acctRole === "Viewer"}
              placeholder="e.g. billing@company.com"
            />
          </F>
          <F label="Enquiry phone (footer line)">
            <input
              value={coDraft.invoiceFooterPhone}
              onChange={e => setCoDraft(p => ({ ...p, invoiceFooterPhone: e.target.value }))}
              style={IS}
              disabled={acctRole === "Viewer"}
              placeholder="e.g. +91 82873 70318"
            />
          </F>
        </div>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", marginBottom: 8, marginTop: 6 }}>BANK DETAILS (PRINTED ON INVOICE)</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
          <F label="Bank name">
            <input
              value={coDraft.bankName}
              onChange={e => setCoDraft(p => ({ ...p, bankName: e.target.value }))}
              style={IS}
              disabled={acctRole === "Viewer"}
              placeholder="e.g. HDFC Bank"
            />
          </F>
          <F label="Account name">
            <input
              value={coDraft.bankAccountName}
              onChange={e => setCoDraft(p => ({ ...p, bankAccountName: e.target.value }))}
              style={IS}
              disabled={acctRole === "Viewer"}
              placeholder="Name as on account / cheque"
            />
          </F>
          <F label="Account number">
            <input
              value={coDraft.bankAccountNumber}
              onChange={e => setCoDraft(p => ({ ...p, bankAccountNumber: e.target.value }))}
              style={IS}
              disabled={acctRole === "Viewer"}
              placeholder="Account number"
            />
          </F>
          <F label="IFSC">
            <input
              value={coDraft.bankIfsc}
              onChange={e => setCoDraft(p => ({ ...p, bankIfsc: e.target.value }))}
              style={IS}
              disabled={acctRole === "Viewer"}
              placeholder="e.g. HDFC0001234"
            />
          </F>
          <F label="Account type">
            <select
              value={coDraft.bankAccountType}
              onChange={e => setCoDraft(p => ({ ...p, bankAccountType: e.target.value }))}
              style={IS}
              disabled={acctRole === "Viewer"}
            >
              <option value="">— Select —</option>
              <option value="Current">Current</option>
              <option value="Cash Credit">Cash Credit</option>
              <option value="Overdraft">Overdraft</option>
              <option value="Savings">Savings</option>
              <option value="Other">Other</option>
            </select>
          </F>
        </div>
        <F label="Bank note (app header & AI — optional)">
          <input
            value={coDraft.bankAccountLabel}
            onChange={e => setCoDraft(p => ({ ...p, bankAccountLabel: e.target.value }))}
            style={IS}
            disabled={acctRole === "Viewer"}
            placeholder="Short label, e.g. Axis Current · …099"
          />
        </F>
      </Modal>

      <Modal
        open={bankImportClearModal != null}
        title="Remove bank-import transactions?"
        onClose={() => setBankImportClearModal(null)}
        onSave={confirmRemoveBankImportTransactions}
        saveDisabled={acctRole === "Viewer"}
        saveLabel={acctRole === "Viewer" ? "View-only" : "Yes, remove all"}
      >
        <div style={{ fontSize: 12, color: SKY.text, lineHeight: 1.6, marginBottom: 12 }}>
          You are about to permanently delete{" "}
          <strong>{bankImportClearModal?.count ?? 0}</strong> transaction(s) that were created from bank statement uploads (tagged{" "}
          <code style={{ fontSize: 10 }}>import:…</code>).
        </div>
        <div style={{ fontSize: 11, color: SKY.muted, lineHeight: 1.55 }}>
          Manual postings, invoice settlements, and chat-posted lines are not removed. Import history will be cleared. This cannot be undone.
        </div>
      </Modal>

      <Modal open={modal==="txn"} title="Add Transaction" onClose={()=>setModal(null)} onSave={()=>addTxn()} saveDisabled={acctRole==="Viewer"} saveLabel={acctRole==="Viewer"?"View-only":"Save Entry"}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:11}}>
          <F label="Date"><input type="date" value={nt.date} onChange={e=>setNt(p=>({...p,date:e.target.value}))} style={IS}/></F>
          <F label="Type">
            <select
              value={nt.drCr}
              onChange={e => {
                const drCr = e.target.value
                setNt(p => {
                  const next = { ...p, drCr }
                  if (!String(p.particulars || "").trim()) next.particulars = pickSuggestedParticulars(txns, p.category, drCr)
                  return next
                })
              }}
              style={IS}
            >
              <option>Debit</option>
              <option>Credit</option>
            </select>
          </F>
          <div style={{ gridColumn: "1/-1" }}>
            <F label="Description / Narration">
              <input
                list="jmt-txn-particulars-dl"
                value={nt.particulars}
                onChange={e => setNt(p => ({ ...p, particulars: e.target.value }))}
                placeholder="Suggested from category & type — pick or edit"
                style={IS}
              />
              <datalist id="jmt-txn-particulars-dl">
                {collectTxnParticularsSuggestions(txns, nt.category, nt.drCr).map(s => (
                  <option key={s} value={s} />
                ))}
                <option value={defaultTxnNarrationForCategory(nt.category, nt.drCr)} />
              </datalist>
            </F>
          </div>
          <F label="Amount (₹)"><input type="number" value={nt.amount} onChange={e=>setNt(p=>({...p,amount:e.target.value}))} placeholder="0" style={IS}/></F>
          <F label="Category">
            <select
              value={nt.category}
              onChange={e => {
                const category = e.target.value
                setNt(p => {
                  const next = { ...p, category }
                  if (!String(p.particulars || "").trim()) next.particulars = pickSuggestedParticulars(txns, category, p.drCr)
                  return next
                })
              }}
              style={IS}
            >
              {CATS.map(c => (
                <option key={c}>
                  {c}
                </option>
              ))}
            </select>
          </F>
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
            This <strong>removes</strong> the invoice from the register and <strong>removes auto-posted bank/TDS lines</strong> for this invoice from the ledger (matched by invoice link). Other manual entries are unchanged.
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
        wide
        title={invoiceModalEditId != null ? "Edit invoice" : "Create New Invoice"}
        onClose={() => {
          setModal(null)
          setInvoiceModalEditId(null)
        }}
        onSave={saveInvoiceFromModal}
        saveDisabled={acctRole === "Viewer"}
        saveLabel={acctRole === "Viewer" ? "View-only" : "Save invoice"}
        footerLeft={
          <button type="button" onClick={printInvoiceDraft} style={{ ...S.btnO, borderColor: `${JM.p}55`, color: JM.p, fontWeight: 700 }}>
            Print / PDF
          </button>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 800,
                color: "#fff",
                background: JM.p,
                padding: "6px 12px",
                borderRadius: 8,
              }}
            >
              1 · Add invoice details
            </span>
            <span style={{ fontSize: 11, fontWeight: 600, color: SKY.muted, padding: "6px 10px" }}>2 · Design &amp; share (optional)</span>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 10, justifyContent: "space-between" }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 22, fontWeight: 800, color: "#5b21b6" }}>Invoice</span>
              <input
                value={ni.subtitle}
                onChange={e => setNi(p => ({ ...p, subtitle: e.target.value }))}
                placeholder="+ Add subtitle"
                style={{ ...IS, minWidth: 200, maxWidth: 360, fontSize: 13 }}
              />
            </div>
            <div
              style={{
                fontSize: 10,
                color: SKY.muted,
                border: `1px dashed ${SKY.borderHi}`,
                borderRadius: 10,
                padding: "10px 14px",
                minWidth: 120,
                textAlign: "center",
              }}
            >
              Logo
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 11 }}>
              <F label="Invoice #">
                <input
                  value={ni.num}
                  onChange={e => setNi(p => ({ ...p, num: e.target.value }))}
                  onFocus={e => {
                    if (invoiceModalEditId != null) return
                    if (!String(e.target.value || "").trim()) {
                      setNi(p => ({
                        ...p,
                        num: suggestNextInvoiceNum(invoices, activeCompany?.invoiceSeriesPrefix),
                      }))
                    }
                  }}
                  placeholder={suggestNextInvoiceNum(invoices, activeCompany?.invoiceSeriesPrefix)}
                  style={IS}
                />
                <div style={{ fontSize: 10, color: SKY.muted, marginTop: 4, lineHeight: 1.4 }}>
                  Next in series is filled automatically; change only if you need a different number.
                </div>
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
                <div style={{ fontSize: 10, color: SKY.muted, marginTop: 4, lineHeight: 1.4 }}>
                  Choosing a saved client sets due date from their last invoice (you can change it). Typing a known client + GSTIN and tabbing out does the same if due date still matches invoice date + payment days.
                </div>
              </F>
            </div>
            <div
              style={{
                border: `1px solid ${SKY.border}`,
                borderRadius: 12,
                padding: 12,
                background: SKY.surface2,
                fontSize: 11,
                color: SKY.muted,
                lineHeight: 1.5,
              }}
            >
              <div style={{ fontSize: 10, fontWeight: 800, color: JM.p, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Summary</div>
              Totals and tax follow your line below. Use <strong style={{ color: SKY.text }}>Print / PDF</strong> for a clean document. Internal notes stay out of the print layout.
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div
              style={{
                border: "1px solid #e9d5ff",
                borderRadius: 12,
                padding: 12,
                background: "linear-gradient(180deg, #faf5ff 0%, #f5f3ff 100%)",
                boxShadow: "0 1px 4px rgba(91,33,182,.08)",
              }}
            >
              <div style={{ fontSize: 10, fontWeight: 800, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Billed by</div>
              {activeCompany?.logoDataUrl && safeInvoiceLogoSrc(activeCompany.logoDataUrl) ? (
                <img
                  src={safeInvoiceLogoSrc(activeCompany.logoDataUrl)}
                  alt=""
                  style={{ maxHeight: 44, maxWidth: 180, objectFit: "contain", marginBottom: 8, display: "block" }}
                />
              ) : null}
              <div style={{ fontWeight: 800, color: "#312e81" }}>{activeCompany?.legalName || activeCompany?.name || "Company"}</div>
              {activeCompany?.legalName && activeCompany?.name && activeCompany.legalName !== activeCompany.name ? (
                <div style={{ fontSize: 11, color: SKY.muted, marginTop: 2 }}>Header: {activeCompany.name}</div>
              ) : null}
              {formatCompanyAddressForInvoice(activeCompany) ? (
                <div style={{ fontSize: 11, color: SKY.text2, marginTop: 8, lineHeight: 1.45 }}>{formatCompanyAddressForInvoice(activeCompany)}</div>
              ) : null}
              {activeCompany?.gstin ? <div style={{ fontSize: 11, marginTop: 6 }}>GSTIN: {activeCompany.gstin}</div> : null}
              {activeCompany?.pan ? <div style={{ fontSize: 11, marginTop: 4 }}>PAN: {activeCompany.pan}</div> : null}
            </div>
            <div
              style={{
                border: "1px solid #e9d5ff",
                borderRadius: 12,
                padding: 12,
                background: "linear-gradient(180deg, #faf5ff 0%, #ffffff 100%)",
                boxShadow: "0 1px 4px rgba(91,33,182,.06)",
              }}
            >
              <div style={{ fontSize: 10, fontWeight: 800, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Billed to</div>
              <F label="Saved client (optional)">
                <select value={ni.clientPresetKey || ""} onChange={e => applyInvoiceClientPresetKey(e.target.value)} style={IS}>
                  <option value="">— Select or type below —</option>
                  {invoiceClientPresets.map(p => (
                    <option key={p.key} value={p.key}>
                      {p.client}
                      {p.gstin ? ` · ${p.gstin}` : ""}
                    </option>
                  ))}
                </select>
              </F>
              <F label="Client name">
                <input
                  value={ni.client}
                  onChange={e => setNi(p => ({ ...p, client: e.target.value, clientPresetKey: "" }))}
                  onBlur={maybeApplyClientDueFromHistory}
                  placeholder="Legal name as on PO / contract"
                  style={IS}
                />
              </F>
              <F label="Client address (printed on invoice)">
                <textarea
                  value={ni.clientAddress}
                  onChange={e => setNi(p => ({ ...p, clientAddress: e.target.value }))}
                  placeholder="Full billing address"
                  rows={3}
                  style={{ ...IS, resize: "vertical", minHeight: 64 }}
                />
              </F>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <F label="Client GSTIN">
                  <input
                    value={ni.gstin}
                    onChange={e => setNi(p => ({ ...p, gstin: e.target.value, clientPresetKey: "" }))}
                    onBlur={maybeApplyClientDueFromHistory}
                    placeholder="29AAACS1234F1Z0"
                    style={IS}
                  />
                </F>
                <F label="Client PAN">
                  <input
                    value={ni.clientPan}
                    onChange={e => setNi(p => ({ ...p, clientPan: e.target.value }))}
                    placeholder="AAAPA1234A"
                    style={IS}
                  />
                </F>
              </div>
              <F label="Place of supply">
                <select value={ni.place} onChange={e => setNi(p => ({ ...p, place: e.target.value, clientPresetKey: "" }))} style={IS}>
                  <option value="intra">Intra-state (CGST + SGST)</option>
                  <option value="inter">Inter-state (IGST)</option>
                </select>
              </F>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 10,
              padding: "10px 12px",
              background: SKY.surface2,
              borderRadius: 10,
              border: `1px solid ${SKY.border}`,
            }}
          >
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: SKY.muted, cursor: "not-allowed", opacity: 0.55 }}>
              <input type="checkbox" disabled />
              Add shipping
            </label>
            <span style={{ fontSize: 11, color: SKY.muted }}>Currency</span>
            <select disabled style={{ ...IS, width: 200, opacity: 0.85 }}>
              <option>Indian Rupee (INR, ₹)</option>
            </select>
            <span style={{ fontSize: 10, color: SKY.muted }}>Configure GST via line items below · SAC &amp; revenue category in the table row</span>
          </div>

          {(() => {
            const taxableNum = lineTaxableFromNi(ni)
            const g = computeInvoiceGst(taxableNum, ni.gst_rate, ni.place)
            return (
              <>
                <div style={{ overflowX: "auto", borderRadius: 10, border: "1px solid #c4b5fd" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, minWidth: ni.place === "inter" ? 640 : 720 }}>
                    <thead>
                      <tr style={{ background: "#312e81", color: "#fff" }}>
                        {(ni.place === "inter"
                          ? ["Item", "GST Rate", "Qty", "Rate", "Amount", "IGST", "Total"]
                          : ["Item", "GST Rate", "Qty", "Rate", "Amount", "CGST", "SGST", "Total"]
                        ).map(h => (
                          <th
                            key={h}
                            style={{
                              padding: "8px 6px",
                              textAlign: h === "Item" ? "left" : "right",
                              fontWeight: 800,
                              fontSize: 10,
                              textTransform: "uppercase",
                              letterSpacing: "0.04em",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      <tr style={{ background: "#faf5ff" }}>
                        <td style={{ padding: 8, borderTop: "1px solid #e9d5ff", verticalAlign: "top" }}>
                          <input
                            value={ni.itemName}
                            onChange={e => setNi(p => ({ ...p, itemName: e.target.value }))}
                            placeholder="Item name / SKU"
                            style={{ ...IS, width: "100%", boxSizing: "border-box" }}
                          />
                          {invoiceDescSuggestions.length > 0 ? (
                            <select
                              key={invoiceModalEditId == null ? "inv-desc-new" : `inv-desc-${invoiceModalEditId}`}
                              defaultValue=""
                              onChange={e => {
                                const v = e.target.value
                                if (v) setNi(p => ({ ...p, desc: v }))
                                e.target.value = ""
                              }}
                              style={{ ...IS, width: "100%", boxSizing: "border-box", marginTop: 6, fontSize: 10, color: SKY.muted }}
                            >
                              <option value="">Insert from past invoices…</option>
                              {invoiceDescSuggestions.map(s => (
                                <option key={s} value={s}>
                                  {s.length > 72 ? `${s.slice(0, 72)}…` : s}
                                </option>
                              ))}
                            </select>
                          ) : null}
                          <textarea
                            value={ni.desc}
                            onChange={e => setNi(p => ({ ...p, desc: e.target.value }))}
                            placeholder="+ Description (period, PO ref…)"
                            style={{ ...IS, resize: "vertical", minHeight: 44, width: "100%", boxSizing: "border-box", marginTop: 6, fontSize: 11 }}
                          />
                          <div style={{ fontSize: 10, color: SKY.muted, marginTop: 6, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                            <span>HSN/SAC</span>
                            <input
                              value={ni.sac}
                              onChange={e => setNi(p => ({ ...p, sac: e.target.value, clientPresetKey: "" }))}
                              placeholder="998314"
                              style={{ ...IS, width: 88, fontSize: 11 }}
                            />
                          </div>
                        </td>
                        <td style={{ padding: 8, borderTop: "1px solid #e9d5ff", verticalAlign: "top" }}>
                          <select value={ni.gst_rate} onChange={e => setNi(p => ({ ...p, gst_rate: e.target.value }))} style={{ ...IS, width: 72 }}>
                            <option value="18">18%</option>
                            <option value="12">12%</option>
                            <option value="5">5%</option>
                            <option value="0">0%</option>
                          </select>
                        </td>
                        <td style={{ padding: 8, borderTop: "1px solid #e9d5ff", textAlign: "right", verticalAlign: "top" }}>
                          <input
                            type="number"
                            min={0}
                            step="any"
                            value={ni.qty}
                            onChange={e => setNi(p => ({ ...p, qty: e.target.value }))}
                            placeholder="1"
                            style={{ ...IS, width: 72, textAlign: "right" }}
                          />
                        </td>
                        <td style={{ padding: 8, borderTop: "1px solid #e9d5ff", textAlign: "right", verticalAlign: "top" }}>
                          <input
                            type="number"
                            min={0}
                            step="any"
                            value={ni.unitRate}
                            onChange={e => setNi(p => ({ ...p, unitRate: e.target.value }))}
                            placeholder="0"
                            style={{ ...IS, width: 88, textAlign: "right" }}
                          />
                        </td>
                        <td style={{ padding: 8, borderTop: "1px solid #e9d5ff", textAlign: "right", fontWeight: 600 }}>₹{inr(taxableNum)}</td>
                        {ni.place === "inter" ? (
                          <td style={{ padding: 8, borderTop: "1px solid #e9d5ff", textAlign: "right", color: SKY.text }}>₹{inr(g.igst)}</td>
                        ) : (
                          <>
                            <td style={{ padding: 8, borderTop: "1px solid #e9d5ff", textAlign: "right", color: SKY.text }}>₹{inr(g.cgst)}</td>
                            <td style={{ padding: 8, borderTop: "1px solid #e9d5ff", textAlign: "right", color: SKY.text }}>₹{inr(g.sgst)}</td>
                          </>
                        )}
                        <td style={{ padding: 8, borderTop: "1px solid #e9d5ff", textAlign: "right", fontWeight: 800, color: "#312e81" }}>₹{inr(g.total)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 14, alignItems: "start", marginTop: 14 }}>
                  <div
                    style={{
                      border: "1px solid #e9d5ff",
                      borderRadius: 12,
                      padding: 12,
                      background: "linear-gradient(180deg, #faf5ff 0%, #f5f3ff 100%)",
                    }}
                  >
                    <div style={{ fontSize: 9, fontWeight: 800, color: "#5b21b6", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Bank details</div>
                    {activeCompany?.bankAccountName ||
                    activeCompany?.bankName ||
                    activeCompany?.bankAccountNumber ||
                    activeCompany?.bankIfsc ||
                    activeCompany?.bankAccountType ? (
                      <>
                        {activeCompany.bankAccountName ? (
                          <div style={{ fontSize: 11, marginTop: 2 }}>
                            <strong>Account name:</strong> {activeCompany.bankAccountName}
                          </div>
                        ) : null}
                        {activeCompany.bankAccountNumber ? (
                          <div style={{ fontSize: 11, marginTop: 2 }}>
                            <strong>Account number:</strong> {activeCompany.bankAccountNumber}
                          </div>
                        ) : null}
                        {activeCompany.bankIfsc ? (
                          <div style={{ fontSize: 11, marginTop: 2 }}>
                            <strong>IFSC:</strong> {activeCompany.bankIfsc}
                          </div>
                        ) : null}
                        {activeCompany.bankAccountType ? (
                          <div style={{ fontSize: 11, marginTop: 2 }}>
                            <strong>Account type:</strong> {activeCompany.bankAccountType}
                          </div>
                        ) : null}
                        {activeCompany.bankName ? (
                          <div style={{ fontSize: 11, marginTop: 2 }}>
                            <strong>Bank:</strong> {activeCompany.bankName}
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <div style={{ fontSize: 11, color: SKY.muted, lineHeight: 1.45 }}>Add bank details under Company settings to show on the printed invoice.</div>
                    )}
                    {activeCompany?.bankAccountLabel ? (
                      <div style={{ fontSize: 10, color: SKY.muted, marginTop: 8, lineHeight: 1.45 }}>Note: {activeCompany.bankAccountLabel}</div>
                    ) : null}
                  </div>
                  <div
                    style={{
                      border: "1px solid #e9d5ff",
                      borderRadius: 12,
                      padding: 12,
                      background: "linear-gradient(180deg, #ffffff 0%, #faf5ff 100%)",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                      <span style={{ color: SKY.muted }}>Amount</span>
                      <span>₹{inr(taxableNum)}</span>
                    </div>
                    {ni.place === "inter" ? (
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                        <span style={{ color: SKY.muted }}>IGST</span>
                        <span>₹{inr(g.igst)}</span>
                      </div>
                    ) : (
                      <>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                          <span style={{ color: SKY.muted }}>CGST</span>
                          <span>₹{inr(g.cgst)}</span>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                          <span style={{ color: SKY.muted }}>SGST</span>
                          <span>₹{inr(g.sgst)}</span>
                        </div>
                      </>
                    )}
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: 15,
                        fontWeight: 800,
                        marginTop: 8,
                        paddingTop: 8,
                        borderTop: "3px double #c4b5fd",
                        color: "#312e81",
                      }}
                    >
                      <span>Total (INR)</span>
                      <span>₹{inr(g.total)}</span>
                    </div>
                    <div style={{ fontSize: 11, color: SKY.muted, marginTop: 10, lineHeight: 1.45 }}>
                      <strong style={{ color: SKY.text2 }}>Amount in words:</strong> {inrAmountWords(g.total)}
                    </div>
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 11, marginTop: 14 }}>
                  <F label="Revenue category (ledger)">
                    <select
                      value={ni.revenueCategory}
                      onChange={e => setNi(p => ({ ...p, revenueCategory: e.target.value, clientPresetKey: "" }))}
                      style={IS}
                    >
                      {REVENUE_CATS.map(c => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </F>
                  <F label="Internal notes">
                    <input
                      value={ni.notes}
                      onChange={e => setNi(p => ({ ...p, notes: e.target.value }))}
                      placeholder="Not shown on print"
                      style={IS}
                    />
                  </F>
                </div>
              </>
            )
          })()}
        </div>
      </Modal>

      <Modal
        open={invPayId != null}
        title={invPayMode === "replace" ? "Edit payment/status" : "Record payment"}
        onClose={() => {
          setInvPayId(null)
          setInvPayMode("add")
          setInvPayAmt("")
          setInvPayTdsPct("")
        }}
        onSave={applyInvoicePaymentModal}
        saveDisabled={acctRole === "Viewer"}
        saveLabel={invPayMode === "replace" ? "Save changes" : "Apply payment"}
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
        <F label={invPayMode === "replace" ? "Total credited to bank (₹)" : "Credited to bank now (₹)"}>
          <input type="number" value={invPayAmt} onChange={e => setInvPayAmt(e.target.value)} style={IS} placeholder={invPayMode === "replace" ? "Total bank received for this invoice" : "Net received in CA"} />
        </F>
        <F label="TDS deducted by client (%) on taxable — optional">
          <input type="number" value={invPayTdsPct} onChange={e => setInvPayTdsPct(e.target.value)} style={IS} placeholder="0 if none" min="0" max="99.99" step="0.01" />
        </F>
        {(() => {
          const t = invoices.find(i => i.id === invPayId)
          if (!t) return null
          const bal = invoiceBalance(t)
          const taxable = Math.max(0, Number(t.taxable) || 0)
          const baseTds = Math.max(0, Number(t.paidTdsTotal) || 0)
          const recv = parseMoneyInput(invPayAmt)
          const pRaw = parseFloat(String(invPayTdsPct).replace(/,/g, ""))
          const pct = Number.isFinite(pRaw) ? Math.max(0, Math.min(99.99, pRaw)) : 0
          const tdsFromTaxable = pct > 0 ? Math.round((taxable * pct) / 100 * 100) / 100 : 0
          const tds = invPayMode === "replace" ? tdsFromTaxable : Math.max(0, Math.round((tdsFromTaxable - baseTds) * 100) / 100)
          const settle = Math.round((recv + tds) * 100) / 100
          const refBal = invPayMode === "replace" ? Number(t.total) || 0 : bal
          const rem = Math.round((refBal - settle) * 100) / 100
          return (
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 4, padding: "8px 10px", background: "#ffffff", borderRadius: 8, border: "1px solid #bae6fd", lineHeight: 1.5 }}>
              <strong style={{ color: "#94a3b8" }}>Settlement toward invoice:</strong> ₹{inr(recv)} bank + ₹{inr(tds)} TDS ({pct.toFixed(2)}% of taxable ₹{inr(taxable)}) ={" "}
              <strong style={{ color: "#0c4a6e" }}>₹{inr(settle)}</strong>
              <br />
              {invPayMode === "replace" ? "After save, total balance due" : "After apply, balance due"} ≈ ₹{inr(Math.max(0, rem))}
              {settle > refBal + 0.01 ? <span style={{ color: "#f59e0b" }}> · Excess is trimmed to match allowed balance.</span> : null}
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

export default function App() {
  const { user, activeCompany, loading, onboardingStep, logout, changePasswordRequest } = useAuth()

  if (loading) {
    return (
      <div className={authStyles.spinnerWrap}>
        <div className={authStyles.spinner} />
      </div>
    )
  }

  if (!user || onboardingStep || !activeCompany) {
    return <AuthRouter />
  }

  return (
    <BooksApp
      authUser={{
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      }}
      onLogout={logout}
      onChangePassword={changePasswordRequest}
    />
  )
}
