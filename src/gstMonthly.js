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

/** Issued invoices — the legal source of output GST (liability arises on the invoice date). */
export const gstInvoices = invoices => (invoices || []).filter(i => i && i.status !== "draft" && Number(i.total) > 0.005 && /^\d{4}-\d{2}-\d{2}$/.test(String(i.date || "")))

/** Output GST of the invoices, split by tax head. */
export function invoiceOutputGst(invoices) {
  const o = { taxable: 0, igst: 0, cgst: 0, sgst: 0 }
  for (const i of gstInvoices(invoices)) {
    o.taxable += Number(i.taxable) || 0
    o.igst += Number(i.igst) || 0
    o.cgst += Number(i.cgst) || 0
    o.sgst += Number(i.sgst) || 0
  }
  return { taxable: r2(o.taxable), igst: r2(o.igst), cgst: r2(o.cgst), sgst: r2(o.sgst), total: r2(o.igst + o.cgst + o.sgst) }
}

/**
 * @param ledger    all non-void txns (full books — settlement is matched across report periods)
 * @param invoices  invoice register; when it has issued invoices, output GST comes only from them
 *                  (exact, by invoice month) and bank credits are not used to estimate it
 */
export function gstSettlementByMonth(ledger, invoices, portal = []) {
  // With portal ledgers, the portal's monthly utilisation (ITC + cash) is what settled GST; bank
  // payments and manual set-offs are then only deposits / history and must not count again.
  const usePortal = Array.isArray(portal) && portal.length > 0
  const mon = new Map()
  const at = k => {
    if (!mon.has(k)) mon.set(k, { month: k, taxable: 0, gst: 0, bank: 0, itc: 0, other: 0, items: [] })
    return mon.get(k)
  }
  const issued = gstInvoices(invoices)
  for (const i of issued) {
    const [y, mo] = i.date.split("-")
    const m = at(`${mo}/${y}`)
    m.taxable += Number(i.taxable) || 0
    m.gst += (Number(i.igst) || 0) + (Number(i.cgst) || 0) + (Number(i.sgst) || 0)
  }
  for (const t of ledger || []) {
    if (t.void) continue
    const p = String(t.date || "").split("/")
    if (p.length !== 3) continue
    if (t.drCr === "CR" && String(t.category || "").startsWith("Revenue")) {
      if (issued.length) continue
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
    } else if (usePortal) {
      continue
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
  if (usePortal) {
    for (const p of portal) {
      const m = at(p.month)
      m.itc += Number(p.itcUtilized) || 0
      m.other += Number(p.cashUtilized) || 0
      m.deposited = (m.deposited || 0) + (Number(p.cashDeposited) || 0)
      m.itcCredited = (m.itcCredited || 0) + (Number(p.itcCredited) || 0)
    }
  }
  let running = 0
  return [...mon.values()]
    .sort((a, b) => monthSortKey(a.month) - monthSortKey(b.month))
    .map(m => {
      const settled = r2(m.bank + m.itc + m.other)
      const pending = r2(m.gst - settled)
      running = r2(running + pending)
      return {
        ...m,
        taxable: r2(m.taxable),
        gst: r2(m.gst),
        bank: r2(m.bank),
        itc: r2(m.itc),
        other: r2(m.other),
        deposited: r2(m.deposited),
        itcCredited: r2(m.itcCredited),
        settled,
        pending,
        // Carried balance: an excess in one month offsets shortfalls in others (like the GST cash ledger).
        running,
        portal: usePortal,
      }
    })
    .filter(m => m.gst > 0.5 || m.settled > 0.005 || m.deposited > 0.005 || m.itcCredited > 0.005)
}
