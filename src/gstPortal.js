/**
 * GST portal ledgers (Electronic Credit + Cash Ledger), month-wise:
 *   ITC credited / ITC utilised / cash deposited / cash utilised.
 *
 * Journals posted for each month (system rows, ref `gstp:`):
 *   ITC credited   Dr GST Input / ITC Receivable      Cr ITC Claimed on Purchases (purchases were expensed gross)
 *   ITC utilised   Dr GST Payable (or GST expense)    Cr GST Input / ITC Receivable
 *   Cash deposit   Dr GST Electronic Cash Ledger      Cr GST Deposits – Funding Source Pending (clearing)
 *   Cash utilised  Dr GST Payable (or GST expense)    Cr GST Electronic Cash Ledger
 * Bank GST payments (category "GST Deposit …") debit the clearing account, so whatever the bank did
 * not fund stays in clearing until a funding source (director / cash / other bank) is chosen.
 */

import {
  GST_CASH_LEDGER,
  GST_DEPOSIT,
  GST_DEPOSIT_CLEARING,
  GST_OTHER_SOURCES,
  GST_PAYABLE_NET,
  ITC_RECEIVABLE,
  inferFY,
} from "./accountingEngine.js"

const r2 = n => Math.round((Number(n) || 0) * 100) / 100
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
export const GST_PORTAL_CATEGORY = "GST Portal Ledger"
export const isGstPortalTxn = t => String(t?.audit?.ref || "").startsWith("gstp:")

/** "Dec 2024", "Oct 2026*", "12/2024", "2024-12" → "12/2024" */
function parseMonth(raw) {
  // Footnote marks such as "Oct 2026*" (or Markdown-escaped "Oct 2026\\*") are not part of the month.
  const s = String(raw || "").toLowerCase().replace(/[\\*\s]+$/g, "").trim()
  let m = /^([a-z]{3})[a-z]*[\s\-'/]+(\d{2,4})$/.exec(s)
  if (m && MONTHS.includes(m[1])) {
    const y = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2])
    return `${String(MONTHS.indexOf(m[1]) + 1).padStart(2, "0")}/${y}`
  }
  m = /^(\d{1,2})[/-](\d{4})$/.exec(s)
  if (m) return `${m[1].padStart(2, "0")}/${m[2]}`
  m = /^(\d{4})[/-](\d{1,2})$/.exec(s)
  if (m) return `${m[2].padStart(2, "0")}/${m[1]}`
  return null
}

const num = v => {
  const n = Number(String(v ?? "").replace(/[₹,\s]/g, ""))
  return Number.isFinite(n) ? r2(n) : 0
}

const COLS = {
  itcCredited: [/itc.*credit/],
  itcUtilized: [/itc.*utili[sz]/],
  cashDeposited: [/cash.*deposit/],
  cashUtilized: [/cash.*utili[sz]/],
}

/**
 * Parse a pasted month-wise summary (Markdown table, TSV or CSV) with columns
 * Month, ITC credited, ITC utilized, Cash deposited, Cash utilized (any order; extra columns ignored).
 * @returns {{ rows: object[], error?: string }}
 */
export function parseGstPortalSummary(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !/^\|?\s*:?-{2,}/.test(l))
  const split = l => {
    if (l.includes("|")) return l.replace(/^\||\|$/g, "").split("|").map(c => c.trim())
    if (l.includes("\t")) return l.split("\t").map(c => c.trim())
    // CSV: commas inside numbers only appear quoted
    const out = []
    let cur = ""
    let q = false
    for (const ch of l) {
      if (ch === '"') q = !q
      else if (ch === "," && !q) {
        out.push(cur.trim())
        cur = ""
      } else cur += ch
    }
    out.push(cur.trim())
    return out
  }
  const hi = lines.findIndex(l => /month/i.test(l) && /itc/i.test(l))
  if (hi < 0) return { rows: [], error: "Header row not found — need columns Month, ITC credited, ITC utilized, Cash deposited, Cash utilized." }
  const head = split(lines[hi]).map(h => h.toLowerCase())
  const idx = { month: head.findIndex(h => /month/.test(h)) }
  for (const [k, res] of Object.entries(COLS)) idx[k] = head.findIndex(h => res.some(re => re.test(h)))
  const missing = Object.entries(idx).filter(([, i]) => i < 0).map(([k]) => k)
  if (missing.length) return { rows: [], error: `Missing column(s): ${missing.join(", ")}` }
  const rows = []
  for (const l of lines.slice(hi + 1)) {
    const c = split(l)
    const month = parseMonth(c[idx.month])
    if (!month) continue // totals / notes
    rows.push({
      month,
      itcCredited: num(c[idx.itcCredited]),
      itcUtilized: num(c[idx.itcUtilized]),
      cashDeposited: num(c[idx.cashDeposited]),
      cashUtilized: num(c[idx.cashUtilized]),
    })
  }
  if (!rows.length) return { rows: [], error: "No month rows found under the header." }
  return { rows: normalizeGstPortal(rows) }
}

const monthKey = m => {
  const [mo, y] = String(m).split("/").map(Number)
  return y * 100 + mo
}

export function normalizeGstPortal(raw) {
  if (!Array.isArray(raw)) return []
  const byMonth = new Map()
  for (const r of raw) {
    if (!r || !/^\d{2}\/\d{4}$/.test(String(r.month || ""))) continue
    byMonth.set(r.month, {
      month: r.month,
      itcCredited: num(r.itcCredited),
      itcUtilized: num(r.itcUtilized),
      cashDeposited: num(r.cashDeposited),
      cashUtilized: num(r.cashUtilized),
    })
  }
  return [...byMonth.values()].sort((a, b) => monthKey(a.month) - monthKey(b.month))
}

const pad = n => String(n).padStart(2, "0")
const ddmm = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`
const capToday = (d, today) => (d > today ? today : d)
const monthEnd = (m, today) => {
  const [mo, y] = m.split("/").map(Number)
  return ddmm(capToday(new Date(y, mo, 0), today))
}
/** GSTR-3B for a month is filed by the 20th of the next month. */
const filingDate = (m, today) => {
  const [mo, y] = m.split("/").map(Number)
  return ddmm(capToday(new Date(y, mo, 20), today))
}

/** Bank payments booked as deposits into the electronic cash ledger. */
export const isGstBankDeposit = t => !t.void && t.category === GST_DEPOSIT && !String(t?.audit?.ref || "").startsWith("gstp:")

/**
 * Journal rows the portal summary implies. `fundingSource` (key of GST_OTHER_SOURCES) books the part of
 * the deposits the bank did not pay.
 */
export function gstPortalRows(portal, { accrual, fundingSource, bankDeposits = 0, today = new Date() } = {}) {
  const liab = accrual ? GST_PAYABLE_NET : "GST Payment – Output Tax (GSTR-3B)"
  const out = []
  const add = (ref, date, amount, particulars, dr, cr) => {
    const a = r2(amount)
    if (a <= 0.005) return
    out.push({
      ref,
      date,
      amount: a,
      particulars,
      journalLines: [
        { account: dr, debit: a, credit: 0 },
        { account: cr, debit: 0, credit: a },
      ],
    })
  }
  for (const p of normalizeGstPortal(portal)) {
    const k = p.month.replace("/", "-")
    add(`gstp:${k}:itcin`, monthEnd(p.month, today), p.itcCredited, `GST portal ${p.month} — ITC credited (Electronic Credit Ledger)`, ITC_RECEIVABLE, "ITC Claimed on Purchases (contra-expense)")
    add(`gstp:${k}:itcuse`, filingDate(p.month, today), p.itcUtilized, `GST portal ${p.month} — ITC utilised against GST`, liab, ITC_RECEIVABLE)
    add(`gstp:${k}:dep`, monthEnd(p.month, today), p.cashDeposited, `GST portal ${p.month} — cash deposited (Electronic Cash Ledger)`, GST_CASH_LEDGER, GST_DEPOSIT_CLEARING)
    add(`gstp:${k}:cashuse`, filingDate(p.month, today), p.cashUtilized, `GST portal ${p.month} — cash utilised against GST`, liab, GST_CASH_LEDGER)
  }
  const deposits = r2(normalizeGstPortal(portal).reduce((s, p) => s + p.cashDeposited, 0))
  const gap = r2(deposits - bankDeposits)
  const src = GST_OTHER_SOURCES[fundingSource]
  if (src && gap > 0.005) {
    add("gstp:funding", ddmm(today), gap, `GST deposits not paid from this bank — ${src.label}`, GST_DEPOSIT_CLEARING, src.account)
  }
  return out
}

const sig = t => JSON.stringify([t.date, t.amount, t.particulars, t.journalLines])

/** Bring `gstp:` ledger rows in line with the portal summary. Returns the same array when unchanged. */
export function syncGstPortal(txns, portal, opts) {
  const list = txns || []
  const bankDeposits = r2(list.filter(isGstBankDeposit).reduce((s, t) => s + (Number(t.amount) || 0), 0))
  const wanted = gstPortalRows(portal, { ...opts, bankDeposits })
  const existing = new Map(list.filter(isGstPortalTxn).map(t => [t.audit.ref, t]))
  const wantedRefs = new Set(wanted.map(w => w.ref))
  let changed = [...existing.keys()].some(ref => !wantedRefs.has(ref))
  let nextId = Math.max(0, ...list.map(t => Number(t.id) || 0))
  const rows = wanted.map(w => {
    const prev = existing.get(w.ref)
    const row = {
      id: prev ? prev.id : ++nextId,
      date: w.date,
      particulars: w.particulars,
      amount: w.amount,
      drCr: "DR",
      category: GST_PORTAL_CATEGORY,
      fy: inferFY(w.date),
      excludeFromBankRunning: true,
      journalLines: w.journalLines,
      void: false,
      audit: { ref: w.ref, createdAt: prev?.audit?.createdAt || new Date().toISOString(), createdBy: "system" },
    }
    if (!prev || sig(prev) !== sig(row)) changed = true
    return prev && sig(prev) === sig(row) ? prev : row
  })
  if (!changed) return list
  return [...list.filter(t => !isGstPortalTxn(t)), ...rows]
}

/** Portal balances: unused ITC, cash lying in the electronic cash ledger, deposits vs bank. */
export function gstPortalBalances(portal, txns) {
  const p = normalizeGstPortal(portal)
  const s = k => r2(p.reduce((a, r) => a + r[k], 0))
  const bank = r2((txns || []).filter(isGstBankDeposit).reduce((a, t) => a + (Number(t.amount) || 0), 0))
  return {
    itcBalance: r2(s("itcCredited") - s("itcUtilized")),
    cashBalance: r2(s("cashDeposited") - s("cashUtilized")),
    deposited: s("cashDeposited"),
    bankDeposits: bank,
    outsideBank: r2(s("cashDeposited") - bank),
    utilized: r2(s("itcUtilized") + s("cashUtilized")),
  }
}
