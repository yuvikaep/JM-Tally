/**
 * Invoice-based (accrual) books: every issued invoice posts its own journal, so receivables,
 * revenue and GST in the ledger always agree with the invoice register.
 *
 *  Invoice (row shown as a revenue credit):
 *                    Dr Accounts Receivable (total)  / Cr Revenue (taxable) + Cr GST Payable – Net (tax)
 *  TDS by customer:  Dr TDS Receivable               / Cr Accounts Receivable
 *  Bank receipt:     category "Customer Receipt (against invoice)" → Dr Bank / Cr Accounts Receivable
 */

import { CUSTOMER_TDS, GST_PAYABLE_NET, categoryToNominalAccount, inferFY } from "./accountingEngine.js"

const r2 = n => Math.round((Number(n) || 0) * 100) / 100
const AR = "Accounts Receivable – Trade"
const isoToDdMm = iso => {
  const [y, m, d] = String(iso || "").split("-")
  return y && m && d ? `${d}/${m}/${y}` : ""
}
export const accrualRef = (invId, kind) => `accr:${invId}:${kind}`
export const isAccrualTxn = t => String(t?.audit?.ref || "").startsWith("accr:")

/** Journal rows an invoice should have in the ledger (none for drafts). */
export function invoiceAccrualRows(inv) {
  if (!inv || inv.status === "draft") return []
  const date = isoToDdMm(inv.date)
  if (!date) return []
  const total = r2(inv.total)
  const taxable = r2(inv.taxable)
  const gst = r2((Number(inv.cgst) || 0) + (Number(inv.sgst) || 0) + (Number(inv.igst) || 0))
  if (total <= 0.005) return []
  const lines = [{ account: AR, debit: total, credit: 0 }, { account: categoryToNominalAccount(inv.revenueCategory || "Revenue - B2B Services"), debit: 0, credit: taxable }]
  if (gst > 0.005) lines.push({ account: GST_PAYABLE_NET, debit: 0, credit: gst })
  const diff = r2(total - taxable - gst)
  if (Math.abs(diff) > 0.005) lines.push(diff > 0 ? { account: "Rounding Off Income", debit: 0, credit: diff } : { account: "Rounding Off Expense", debit: -diff, credit: 0 })
  const rows = [
    {
      date,
      particulars: `Sales invoice ${inv.num} — ${inv.client}`,
      amount: total,
      // Shown as a revenue credit so sales analytics count invoiced sales; the journal is AR / Revenue / GST.
      drCr: "CR",
      category: inv.revenueCategory || "Revenue - B2B Services",
      journalLines: lines,
      ref: accrualRef(inv.id, "inv"),
    },
  ]
  const tds = r2(inv.paidTdsTotal)
  if (tds > 0.005) {
    const tdsDate = isoToDdMm(inv.paidAt) || date
    rows.push({
      date: tdsDate,
      particulars: `TDS deducted by customer — ${inv.num} — ${inv.client}`,
      amount: tds,
      drCr: "DR",
      category: CUSTOMER_TDS,
      journalLines: [
        { account: "TDS Receivable", debit: tds, credit: 0 },
        { account: AR, debit: 0, credit: tds },
      ],
      ref: accrualRef(inv.id, "tds"),
    })
  }
  return rows
}

const sig = t => JSON.stringify([t.date, t.amount, t.particulars, t.journalLines])

/**
 * Bring the ledger's accrual rows in line with the invoice register (or remove them all when off).
 * Returns the same array when nothing changed so callers can skip a state update.
 */
export function syncInvoiceAccrual(txns, invoices, enabled) {
  const list = txns || []
  const existing = new Map(list.filter(isAccrualTxn).map(t => [t.audit.ref, t]))
  const wanted = enabled ? (invoices || []).flatMap(invoiceAccrualRows) : []
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
      drCr: w.drCr,
      category: w.category,
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
  return [...list.filter(t => !isAccrualTxn(t)), ...rows]
}

const NAME_STOPWORDS = new Set(["private", "limited", "technologies", "technology", "solutions", "solution", "services", "service", "india", "pvt", "ltd", "llp", "the", "and", "global", "outsourcing", "logistics", "logistic", "chain", "tech"])
const nameTokens = n => String(n || "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !NAME_STOPWORDS.has(w))
const ddmmMs = d => {
  const [a, b, c] = String(d || "").split("/").map(Number)
  return a && b && c ? new Date(c, b - 1, a).getTime() : NaN
}
const isoMs = s => new Date(`${s}T00:00:00`).getTime()
const msToIso = ms => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}
const DAY = 86400000

/**
 * Set each paid invoice's payment date from the bank receipt that paid it (imported exports often
 * carry the export date instead). Pass 1: same client + amount within ₹1; pass 2: same client,
 * amount within 15%, within 90 days; otherwise the due date. Each receipt is used once.
 * @returns {{ invoices: object[], exact: number, approx: number, fallback: number }}
 */
export function matchInvoicePaymentDates(invoices, txns, receiptCategory) {
  const receipts = (txns || []).filter(
    t => !t.void && t.drCr === "CR" && !t.excludeFromBankRunning && (t.category === receiptCategory || String(t.category || "").startsWith("Revenue"))
  )
  const used = new Set()
  const paid = (invoices || []).filter(i => (Number(i.paidBankTotal) || 0) > 0.005 && i.date)
  const order = [...paid].sort((a, b) => String(a.date).localeCompare(String(b.date)))
  const found = new Map()
  const pick = (inv, tolerance, windowDays) => {
    const tk = nameTokens(inv.client)
    const from = isoMs(inv.date) - 3 * DAY
    const amt = Number(inv.paidBankTotal)
    const hit = receipts
      .filter(t => {
        if (used.has(t.id)) return false
        const ms = ddmmMs(t.date)
        if (!(ms >= from) || (windowDays && ms > from + windowDays * DAY)) return false
        const p = String(t.particulars || "").toLowerCase()
        return tk.some(w => p.includes(w.slice(0, 6))) && Math.abs(t.amount - amt) <= tolerance(amt)
      })
      .sort((a, b) => ddmmMs(a.date) - ddmmMs(b.date))[0]
    if (hit) used.add(hit.id)
    return hit
  }
  let exact = 0
  let approx = 0
  for (const inv of order) {
    const hit = pick(inv, () => 1, 0)
    if (hit) {
      found.set(inv.id, hit)
      exact++
    }
  }
  for (const inv of order) {
    if (found.has(inv.id)) continue
    const hit = pick(inv, a => a * 0.15, 90)
    if (hit) {
      found.set(inv.id, hit)
      approx++
    }
  }
  let fallback = 0
  const next = (invoices || []).map(inv => {
    if (!paid.includes(inv)) return inv
    const hit = found.get(inv.id)
    if (hit) return { ...inv, paidAt: msToIso(ddmmMs(hit.date)), receiptTxnId: hit.id }
    fallback++
    return { ...inv, paidAt: inv.dueDate || inv.date, receiptTxnId: null }
  })
  return { invoices: next, exact, approx, fallback }
}
