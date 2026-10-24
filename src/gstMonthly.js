/**
 * Month-wise GST settlement maths: output GST per month vs bank payments, ITC set-off and
 * payments from cash / director / another account.
 */

import { GST_SETOFF_ITC, gstPeriodOf, isGstAdjustmentTxn, isSystemJournalTxn } from "./accountingEngine.js"

export const r2 = n => Math.round((Number(n) || 0) * 100) / 100
export const monthSortKey = k => {
  const [m, y] = String(k).split("/").map(Number)
  return y * 100 + m
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
export const gstMonthLabel = k => {
  const [m, y] = String(k).split("/").map(Number)
  return m && y ? `${MONTHS[m - 1]} ${y}` : k
}

/** Bank debits that are GST deposits (either basis). */
export const isGstBankPayment = t =>
  !t.void && t.drCr === "DR" && !isSystemJournalTxn(t) && (t.category === "GST Payment (Output Tax)" || t.category === "GST Paid (GSTR-3B)")

/**
 * @param ledger  all non-void txns (full books — settlement is matched across report periods)
 */
export function gstSettlementByMonth(ledger) {
  const mon = new Map()
  const at = k => {
    if (!mon.has(k)) mon.set(k, { month: k, taxable: 0, gst: 0, bank: 0, itc: 0, other: 0, items: [] })
    return mon.get(k)
  }
  for (const t of ledger || []) {
    if (t.void) continue
    const p = String(t.date || "").split("/")
    if (p.length !== 3) continue
    if (t.drCr === "CR" && String(t.category || "").startsWith("Revenue")) {
      const m = at(`${p[1]}/${p[2]}`)
      if (isSystemJournalTxn(t)) {
        for (const l of t.journalLines || []) {
          if (l.account === "GST Payable – Net (GSTR-3B)") m.gst += Number(l.credit) || 0
          else if (l.credit > 0) m.taxable += Number(l.credit) || 0
        }
      } else {
        const tx = t.amount / 1.18
        m.taxable += tx
        m.gst += t.amount - tx
      }
    } else if (isGstBankPayment(t)) {
      const m = at(gstPeriodOf(t))
      m.bank += t.amount
      m.items.push(t)
    } else if (isGstAdjustmentTxn(t)) {
      const m = at(gstPeriodOf(t))
      if (t.category === GST_SETOFF_ITC) m.itc += t.amount
      else m.other += t.amount
      m.items.push(t)
    }
  }
  return [...mon.values()]
    .map(m => {
      const settled = r2(m.bank + m.itc + m.other)
      return { ...m, taxable: r2(m.taxable), gst: r2(m.gst), bank: r2(m.bank), itc: r2(m.itc), other: r2(m.other), settled, pending: r2(m.gst - settled) }
    })
    .filter(m => m.gst > 0.5 || m.settled > 0.005)
    .sort((a, b) => monthSortKey(a.month) - monthSortKey(b.month))
}
