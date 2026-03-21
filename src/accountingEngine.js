/**
 * HisaabKitaab — accounting engine (double-entry, COA, validation).
 * Accrual-friendly: map bank lines to balanced journals (Bank ↔ Nominal).
 */

export const BANK_ACCOUNT = "Primary bank account"

/**
 * Chart of Accounts — Indian private limited / SME oriented.
 * Names used in `categoryToNominalAccount` and GST journal helpers must exist here.
 * `normal`: expected natural balance for TB / teaching (Contra assets credit).
 */
export const CHART_OF_ACCOUNTS = {
  Assets: [
    { code: "1000", name: "Cash on Hand", type: "Asset", normal: "Debit" },
    { code: "1010", name: BANK_ACCOUNT, type: "Asset", normal: "Debit" },
    { code: "1015", name: "Bank – Current A/c (Other)", type: "Asset", normal: "Debit" },
    { code: "1020", name: "Bank – Fixed Deposit", type: "Asset", normal: "Debit" },
    { code: "1030", name: "Accounts Receivable – Trade", type: "Asset", normal: "Debit" },
    { code: "1035", name: "Accounts Receivable – Other", type: "Asset", normal: "Debit" },
    { code: "1040", name: "TDS Receivable", type: "Asset", normal: "Debit" },
    { code: "1045", name: "GST Input / ITC Receivable (control)", type: "Asset", normal: "Debit" },
    { code: "1050", name: "GST Input (CGST)", type: "Asset", normal: "Debit" },
    { code: "1051", name: "GST Input (SGST)", type: "Asset", normal: "Debit" },
    { code: "1052", name: "GST Input (IGST)", type: "Asset", normal: "Debit" },
    { code: "1060", name: "Prepaid Expenses", type: "Asset", normal: "Debit" },
    { code: "1070", name: "Advances to Suppliers", type: "Asset", normal: "Debit" },
    { code: "1080", name: "Staff Advances / Loans to Employees", type: "Asset", normal: "Debit" },
    { code: "1200", name: "Inventory", type: "Asset", normal: "Debit" },
    { code: "1300", name: "Fixed Assets – Plant & Machinery", type: "Asset", normal: "Debit" },
    { code: "1310", name: "Fixed Assets – Computer & IT Equipment", type: "Asset", normal: "Debit" },
    { code: "1320", name: "Fixed Assets – Furniture & Fixtures", type: "Asset", normal: "Debit" },
    { code: "1390", name: "Accumulated Depreciation", type: "Asset", normal: "Credit" },
    { code: "1400", name: "Intangible Assets – Software / Licences", type: "Asset", normal: "Debit" },
    { code: "1410", name: "Security Deposits (Asset)", type: "Asset", normal: "Debit" },
    { code: "1420", name: "Capital Work-in-Progress (CWIP)", type: "Asset", normal: "Debit" },
    { code: "1430", name: "Investments – Current (Mutual Funds / Liquid)", type: "Asset", normal: "Debit" },
    { code: "1440", name: "Investments – Non-current (Equity / Others)", type: "Asset", normal: "Debit" },
    { code: "1450", name: "Loans to Related Parties / Subsidiaries", type: "Asset", normal: "Debit" },
    { code: "1460", name: "Other Current Assets", type: "Asset", normal: "Debit" },
    { code: "1470", name: "GST Refund Receivable", type: "Asset", normal: "Debit" },
    { code: "1335", name: "Fixed Assets – Vehicles", type: "Asset", normal: "Debit" },
    { code: "1340", name: "Leasehold Improvements", type: "Asset", normal: "Debit" },
    { code: "1350", name: "Goodwill (acquired)", type: "Asset", normal: "Debit" },
  ],
  Liabilities: [
    { code: "2000", name: "Accounts Payable – Trade", type: "Liability", normal: "Credit" },
    { code: "2005", name: "Accounts Payable – Other", type: "Liability", normal: "Credit" },
    { code: "2010", name: "Salaries & Wages Payable", type: "Liability", normal: "Credit" },
    { code: "2020", name: "Director Remuneration Payable", type: "Liability", normal: "Credit" },
    { code: "2030", name: "Statutory – PF Payable", type: "Liability", normal: "Credit" },
    { code: "2035", name: "Statutory – ESI Payable", type: "Liability", normal: "Credit" },
    { code: "2040", name: "Statutory – Professional Tax Payable", type: "Liability", normal: "Credit" },
    { code: "2050", name: "TDS Payable – 192 Salary", type: "Liability", normal: "Credit" },
    { code: "2055", name: "TDS Payable – 194J Professional", type: "Liability", normal: "Credit" },
    { code: "2060", name: "TDS Payable – 194C Contractor", type: "Liability", normal: "Credit" },
    { code: "2065", name: "TDS Payable – Other", type: "Liability", normal: "Credit" },
    { code: "2070", name: "GST Output Payable (CGST)", type: "Liability", normal: "Credit" },
    { code: "2071", name: "GST Output Payable (SGST)", type: "Liability", normal: "Credit" },
    { code: "2072", name: "GST Output Payable (IGST)", type: "Liability", normal: "Credit" },
    { code: "2080", name: "GST – RCM Payable (if applicable)", type: "Liability", normal: "Credit" },
    { code: "2100", name: "Short-term Borrowings / CC / OD", type: "Liability", normal: "Credit" },
    { code: "2110", name: "Loans Payable – Term Loan", type: "Liability", normal: "Credit" },
    { code: "2120", name: "Loans – Director (Cr)", type: "Liability", normal: "Credit" },
    { code: "2200", name: "Credit Cards Payable", type: "Liability", normal: "Credit" },
    { code: "2210", name: "Unearned / Deferred Revenue", type: "Liability", normal: "Credit" },
    { code: "2220", name: "Customer Advances / Advance from Customers", type: "Liability", normal: "Credit" },
    { code: "2230", name: "Bills Payable", type: "Liability", normal: "Credit" },
    { code: "2240", name: "Outstanding Expenses / Accrued Expenses", type: "Liability", normal: "Credit" },
    { code: "2250", name: "Provision for Expenses", type: "Liability", normal: "Credit" },
    { code: "2260", name: "Long-term Provisions", type: "Liability", normal: "Credit" },
    { code: "2270", name: "Gratuity Payable", type: "Liability", normal: "Credit" },
    { code: "2280", name: "Leave Encashment Payable", type: "Liability", normal: "Credit" },
    { code: "2290", name: "MSME / Creditor ageing (control)", type: "Liability", normal: "Credit" },
    { code: "2090", name: "GST – Interest / Late Fee Payable", type: "Liability", normal: "Credit" },
    { code: "2095", name: "Other Statutory Dues Payable", type: "Liability", normal: "Credit" },
  ],
  Equity: [
    { code: "3000", name: "Share Capital", type: "Equity", normal: "Credit" },
    { code: "3010", name: "Securities Premium", type: "Equity", normal: "Credit" },
    { code: "3020", name: "Owner / Director Capital", type: "Equity", normal: "Credit" },
    { code: "3030", name: "Capital Infusion – Current (suspense)", type: "Equity", normal: "Credit" },
    { code: "3100", name: "Retained Earnings", type: "Equity", normal: "Credit" },
    { code: "3200", name: "Current Year P&L (suspense)", type: "Equity", normal: "Credit" },
    { code: "3300", name: "Reserves & Surplus", type: "Equity", normal: "Credit" },
    { code: "3040", name: "Share Application Money Pending Allotment", type: "Equity", normal: "Credit" },
    { code: "3350", name: "Director Drawings / Remuneration (Dr)", type: "Equity", normal: "Debit" },
    { code: "3360", name: "General Reserve", type: "Equity", normal: "Credit" },
    { code: "3370", name: "Capital Reserve", type: "Equity", normal: "Credit" },
  ],
  Income: [
    { code: "4000", name: "Sales Revenue – Goods", type: "Income", normal: "Credit" },
    { code: "4010", name: "Sales Revenue – Services (B2B)", type: "Income", normal: "Credit" },
    { code: "4100", name: "Service Revenue", type: "Income", normal: "Credit" },
    { code: "4110", name: "Subscription / Recurring Revenue", type: "Income", normal: "Credit" },
    { code: "4120", name: "Project / Milestone Revenue", type: "Income", normal: "Credit" },
    { code: "4200", name: "Interest Income", type: "Income", normal: "Credit" },
    { code: "4210", name: "Other Income", type: "Income", normal: "Credit" },
    { code: "4220", name: "Foreign Exchange Gain", type: "Income", normal: "Credit" },
    { code: "4230", name: "Discount Received", type: "Income", normal: "Credit" },
    { code: "4240", name: "Commission Income", type: "Income", normal: "Credit" },
    { code: "4250", name: "Scrap / Sale of Assets (Income)", type: "Income", normal: "Credit" },
    { code: "4260", name: "Government Grants / Incentives (Income)", type: "Income", normal: "Credit" },
    { code: "4270", name: "Rounding Off Income", type: "Income", normal: "Credit" },
  ],
  "Expenses — Direct & COGS": [
    { code: "5000", name: "Cost of Services / Job Work", type: "Expense", normal: "Debit" },
    { code: "5010", name: "Sub-contractor Expense", type: "Expense", normal: "Debit" },
    { code: "5020", name: "Freight & Courier", type: "Expense", normal: "Debit" },
    { code: "5030", name: "Purchase of Goods (Trading)", type: "Expense", normal: "Debit" },
    { code: "5040", name: "Direct Materials / Consumables", type: "Expense", normal: "Debit" },
  ],
  "Expenses — People": [
    { code: "5100", name: "Salary Expense", type: "Expense", normal: "Debit" },
    { code: "5110", name: "Director Remuneration", type: "Expense", normal: "Debit" },
    { code: "5120", name: "Staff Welfare & Benefits", type: "Expense", normal: "Debit" },
    { code: "5130", name: "Employer PF / ESI Expense", type: "Expense", normal: "Debit" },
    { code: "5140", name: "Recruitment & Training", type: "Expense", normal: "Debit" },
    { code: "5150", name: "Contract Labour Charges", type: "Expense", normal: "Debit" },
    { code: "5160", name: "Gratuity Expense", type: "Expense", normal: "Debit" },
  ],
  "Expenses — Operations": [
    { code: "5200", name: "Rent Expense", type: "Expense", normal: "Debit" },
    { code: "5210", name: "Utilities – Electricity & Water", type: "Expense", normal: "Debit" },
    { code: "5220", name: "Office Supplies & Consumables", type: "Expense", normal: "Debit" },
    { code: "5230", name: "Telephone & Internet", type: "Expense", normal: "Debit" },
    { code: "5240", name: "Software & SaaS Subscriptions", type: "Expense", normal: "Debit" },
    { code: "5250", name: "Marketing & Recruitment", type: "Expense", normal: "Debit" },
    { code: "5260", name: "Travel & Conveyance", type: "Expense", normal: "Debit" },
    { code: "5270", name: "Professional & Vendor Expense", type: "Expense", normal: "Debit" },
    { code: "5280", name: "Legal & Compliance", type: "Expense", normal: "Debit" },
    { code: "5290", name: "Audit & Professional Fees", type: "Expense", normal: "Debit" },
    { code: "5295", name: "Repairs & Maintenance", type: "Expense", normal: "Debit" },
    { code: "5296", name: "Insurance Expense", type: "Expense", normal: "Debit" },
    { code: "5297", name: "Printing & Stationery", type: "Expense", normal: "Debit" },
    { code: "5298", name: "Entertainment & Business Promotion", type: "Expense", normal: "Debit" },
    { code: "5299", name: "CSR Expense", type: "Expense", normal: "Debit" },
    { code: "5285", name: "Donations", type: "Expense", normal: "Debit" },
  ],
  "Expenses — Finance & Tax": [
    { code: "5300", name: "Utilities & Bank Charges", type: "Expense", normal: "Debit" },
    { code: "5310", name: "Interest Expense", type: "Expense", normal: "Debit" },
    { code: "5320", name: "Foreign Exchange Loss", type: "Expense", normal: "Debit" },
    { code: "5400", name: "Income Tax Expense", type: "Expense", normal: "Debit" },
    { code: "5410", name: "GST Expense / Penalties (non-claimable)", type: "Expense", normal: "Debit" },
    { code: "5500", name: "Depreciation Expense", type: "Expense", normal: "Debit" },
    { code: "5600", name: "Miscellaneous Expense", type: "Expense", normal: "Debit" },
    { code: "5610", name: "Bad Debts / Write-offs", type: "Expense", normal: "Debit" },
    { code: "5620", name: "Commission Expense", type: "Expense", normal: "Debit" },
    { code: "5630", name: "Discount Allowed", type: "Expense", normal: "Debit" },
    { code: "5640", name: "Rounding Off Expense", type: "Expense", normal: "Debit" },
    { code: "5650", name: "Loss on Sale of Assets", type: "Expense", normal: "Debit" },
    { code: "5660", name: "Prior Period Items (Expense)", type: "Expense", normal: "Debit" },
    { code: "5990", name: "Suspense Account (clearing)", type: "Expense", normal: "Debit" },
  ],
}

export function flattenCOA() {
  return Object.entries(CHART_OF_ACCOUNTS).flatMap(([group, rows]) =>
    rows.map(r => ({ ...r, group }))
  )
}

/**
 * Static COA rows + debit/credit from journals. Orphans = ledger accounts not on chart.
 */
export function coaRowsWithBalances(txns) {
  const { rows: tbRows, tDr, tCr } = trialBalanceFromJournal(txns)
  const tbMap = new Map(tbRows.map(r => [r.account, r]))
  const coa = flattenCOA()
  const coaNames = new Set(coa.map(r => r.name))
  const merged = coa.map(acc => {
    const t = tbMap.get(acc.name) || { debit: 0, credit: 0 }
    const debit = Math.round(t.debit * 100) / 100
    const credit = Math.round(t.credit * 100) / 100
    return {
      ...acc,
      debit,
      credit,
      netDr: Math.round((debit - credit) * 100) / 100,
    }
  })
  const orphans = tbRows
    .filter(r => !coaNames.has(r.account))
    .map(r => {
      const debit = Math.round(r.debit * 100) / 100
      const credit = Math.round(r.credit * 100) / 100
      return {
        code: "—",
        name: r.account,
        type: "Unmapped",
        normal: "—",
        group: "Journal only (not on chart)",
        debit,
        credit,
        netDr: Math.round((debit - credit) * 100) / 100,
        orphan: true,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
  return { merged, orphans, tDr, tCr }
}

/** Map app category string → primary nominal ledger name (second line of journal) */
export function categoryToNominalAccount(category) {
  if (!category) return "Miscellaneous Expense"
  if (category.startsWith("Revenue")) return "Service Revenue"
  if (/rent/i.test(category)) return "Rent Expense"
  if (category === "Salary") return "Salary Expense"
  if (category === "Director Payment") return "Director Remuneration"
  if (category.startsWith("Recruitment")) return "Marketing & Recruitment"
  if (category.startsWith("Vendor")) return "Professional & Vendor Expense"
  if (category.includes("Capital")) return "Owner / Director Capital"
  if (category === "Bank Charges") return "Utilities & Bank Charges"
  if (category === "Income Tax Refund" || category === "Misc Income") return "Other Income"
  if (category === "NEFT Return") return "Other Income"
  if (category === "Payment Gateway") return "Miscellaneous Expense"
  return "Miscellaneous Expense"
}

/**
 * Build minimum 2-line journal from a single bank-facing transaction.
 * CR (receipt): Dr Bank, Cr Income/Equity nominal
 * DR (payment): Dr Expense nominal, Cr Bank
 */
export function enrichTxnJournal(t) {
  if (t?.journalLines?.length >= 2) return t
  if (!t?.amount && t?.amount !== 0) return t
  return { ...t, journalLines: buildJournalLines({ amount: t.amount, drCr: t.drCr, category: t.category }) }
}

export function buildJournalLines({ amount, drCr, category }) {
  const a = Number(amount) || 0
  const bank = BANK_ACCOUNT
  const nominal = categoryToNominalAccount(category)
  if (drCr === "CR") {
    return [
      { account: bank, debit: a, credit: 0 },
      { account: nominal, debit: 0, credit: a },
    ]
  }
  return [
    { account: nominal, debit: a, credit: 0 },
    { account: bank, debit: 0, credit: a },
  ]
}

/** TDS withheld by customer: Dr TDS Receivable, Cr revenue nominal (no bank movement). */
export function buildInvoiceTdsJournalLines(amount, revenueCategory) {
  const a = Math.round((Number(amount) || 0) * 100) / 100
  const nominal = categoryToNominalAccount(revenueCategory)
  return [
    { account: "TDS Receivable", debit: a, credit: 0 },
    { account: nominal, debit: 0, credit: a },
  ]
}

/**
 * Ledger rows to mirror an invoice settlement (bank inflow + optional TDS).
 * Bank receipt affects running bank balance; TDS row uses `excludeFromBankRunning`.
 */
export function draftInvoiceSettlementTxns({ prevTxns, inv, incBank, incTds, dateDdMmYyyy, stamp = Date.now() }) {
  const catRaw = inv?.revenueCategory
  const cat =
    catRaw && String(catRaw).startsWith("Revenue") ? catRaw : "Revenue - B2B Services"
  const b = Math.round((Number(incBank) || 0) * 100) / 100
  const td = Math.round((Number(incTds) || 0) * 100) / 100
  let id = Math.max(0, ...(prevTxns || []).map(t => Number(t.id) || 0))
  const out = []
  const dateStr = String(dateDdMmYyyy || "").trim() || "01/01/2025"

  if (b > 0.005) {
    id += 1
    const journalLines = buildJournalLines({ amount: b, drCr: "CR", category: cat })
    const v = validateBalanced(journalLines)
    if (!v.ok) return { error: v.errors[0] || "Unbalanced journal (bank receipt)" }
    out.push({
      id,
      date: dateStr,
      particulars: `Bank receipt — ${inv.num} — ${inv.client}`,
      amount: b,
      drCr: "CR",
      category: cat,
      fy: inferFY(dateStr),
      journalLines,
      void: false,
      audit: { ref: `invoice:${inv.id}:bank:${stamp}` },
    })
  }
  if (td > 0.005) {
    id += 1
    const journalLines = buildInvoiceTdsJournalLines(td, cat)
    const v = validateBalanced(journalLines)
    if (!v.ok) return { error: v.errors[0] || "Unbalanced journal (TDS)" }
    out.push({
      id,
      date: dateStr,
      particulars: `TDS deducted by client — ${inv.num} — ${inv.client}`,
      amount: td,
      drCr: "CR",
      category: cat,
      fy: inferFY(dateStr),
      journalLines,
      void: false,
      excludeFromBankRunning: true,
      audit: { ref: `invoice:${inv.id}:tds:${stamp}` },
    })
  }
  return { drafts: out }
}

export function validateBalanced(lines) {
  const d = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0)
  const c = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0)
  const ok = Math.round((d - c) * 100) / 100 === 0 && lines.length >= 2
  return {
    ok,
    totalDebit: d,
    totalCredit: c,
    errors: ok ? [] : [`Debit (${d}) ≠ Credit (${c}) or fewer than 2 lines`],
  }
}

/** POST /transaction style payload */
export function journalFromApiPayload(body) {
  const lines = (body.entries || []).map(e => ({
    account: e.account,
    debit: e.type === "debit" ? Number(e.amount) : 0,
    credit: e.type === "credit" ? Number(e.amount) : 0,
  }))
  return { lines, validation: validateBalanced(lines) }
}

export function parseDdMmYyyy(s) {
  if (!s || typeof s !== "string") return 0
  const p = s.split("/")
  if (p.length !== 3) return 0
  const [dd, mm, yy] = p.map(Number)
  return new Date(yy, mm - 1, dd).getTime()
}

/** Indian FY label from transaction date (dd/mm/yyyy). */
export function inferFY(ddmmyyyy) {
  const p = String(ddmmyyyy || "").split("/")
  if (p.length !== 3) return "2025-26"
  const m = Number(p[1])
  const y = Number(p[2])
  if (m >= 4) return `${y}-${String((y + 1) % 100).padStart(2, "0")}`
  return `${y - 1}-${String(y % 100).padStart(2, "0")}`
}

/**
 * Assign running **bank** balance per row.
 * If a row has an imported `balance` (statement column), we **keep** it — CR/DR amounts
 * in the seed often do not recompute to that figure (partial lines, same-day ordering, etc.).
 * Rows without `balance` chain from the last known figure (new postings).
 */
export function withRecalculatedBalances(txns) {
  const sorted = [...txns].sort((a, b) => parseDdMmYyyy(a.date) - parseDdMmYyyy(b.date) || a.id - b.id)
  let running = null

  return sorted.map(t => {
    if (t.void) return { ...t, balance: null }

    const delta =
      t.excludeFromBankRunning
        ? 0
        : t.drCr === "CR"
          ? Math.round(Number(t.amount) * 100) / 100
          : -Math.round(Number(t.amount) * 100) / 100
    const storedRaw = t.balance
    const stored =
      storedRaw != null && storedRaw !== "" && Number.isFinite(Number(storedRaw))
        ? Math.round(Number(storedRaw) * 100) / 100
        : null

    if (stored != null) {
      running = stored
      return { ...t, balance: running }
    }

    if (running == null) running = 0
    running = Math.round((running + delta) * 100) / 100
    return { ...t, balance: running }
  })
}

/** Remove imported `balance` on rows strictly after (date,id) so balances can be re-chained after void. */
export function stripBalancesAfter(txns, pivotDateDdMmYyyy, pivotId) {
  const pk = parseDdMmYyyy(pivotDateDdMmYyyy) * 1e9 + Number(pivotId)
  return txns.map(t => {
    if (t.void) return t
    const tk = parseDdMmYyyy(t.date) * 1e9 + Number(t.id)
    if (tk > pk) {
      const { balance: _b, ...rest } = t
      return rest
    }
    return t
  })
}

export function isDuplicateTxn(txns, { date, amount, particulars }) {
  const p = (particulars || "").trim().toLowerCase()
  const amt = Number(amount)
  return txns.some(
    t =>
      !t.void &&
      t.date === date &&
      Math.abs(t.amount - amt) < 0.01 &&
      (t.particulars || "").trim().toLowerCase() === p
  )
}

export function isPeriodLocked(isoOrDdMmYyyy, lockedIsoDate) {
  if (!lockedIsoDate) return false
  const lock = new Date(lockedIsoDate + "T23:59:59").getTime()
  let t
  if (typeof isoOrDdMmYyyy === "string" && isoOrDdMmYyyy.includes("-")) {
    t = new Date(isoOrDdMmYyyy + "T12:00:00").getTime()
  } else {
    t = parseDdMmYyyy(String(isoOrDdMmYyyy || ""))
  }
  return t <= lock
}

/** GST templates (India) — taxable = pre-GST amount */
export function gstSalesJournal({ taxable, gstRate = 0.18, useBank = true, debtorAccount = "Accounts Receivable – Trade" }) {
  const t = Number(taxable) || 0
  const gst = Math.round(t * gstRate * 100) / 100
  const total = Math.round((t + gst) * 100) / 100
  const cgst = Math.round((gst / 2) * 100) / 100
  const sgst = Math.round((gst - cgst) * 100) / 100
  const lines = [
    { account: useBank ? BANK_ACCOUNT : debtorAccount, debit: total, credit: 0 },
    { account: "Service Revenue", debit: 0, credit: t },
    { account: "GST Output Payable (CGST)", debit: 0, credit: cgst },
    { account: "GST Output Payable (SGST)", debit: 0, credit: sgst },
  ]
  return { lines, ...validateBalanced(lines) }
}

export function gstPurchaseJournal({ grossInclGst, gstRate = 0.18 }) {
  const g = Number(grossInclGst) || 0
  const net = Math.round((g / (1 + gstRate)) * 100) / 100
  const gst = Math.round((g - net) * 100) / 100
  const half = Math.round((gst / 2) * 100) / 100
  const lines = [
    { account: "Professional & Vendor Expense", debit: net, credit: 0 },
    { account: "GST Input (CGST)", debit: half, credit: 0 },
    { account: "GST Input (SGST)", debit: Math.round((gst - half) * 100) / 100, credit: 0 },
    { account: BANK_ACCOUNT, debit: 0, credit: g },
  ]
  return { lines, ...validateBalanced(lines) }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** Month-wise bank receipts & payments (non-void). */
export function aggregateMonthlyCashflow(txns) {
  const act = (txns || []).filter(t => !t.void)
  const mon = {}
  for (const t of act) {
    if (t.excludeFromBankRunning) continue
    const p = String(t.date || "").split("/")
    if (p.length !== 3) continue
    const k = `${p[1]}/${p[2]}`
    if (!mon[k]) mon[k] = { cr: 0, dr: 0, mm: Number(p[1]), yy: Number(p[2]) }
    const b = mon[k]
    const amt = Number(t.amount) || 0
    if (t.drCr === "CR") b.cr += amt
    else b.dr += amt
  }
  return Object.entries(mon)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, d]) => ({
      m: `${MONTHS[Math.max(0, Math.min(11, (d.mm || 1) - 1))]}'${String(d.yy).slice(-2)}`,
      cr: Math.round(d.cr * 100) / 100,
      dr: Math.round(d.dr * 100) / 100,
    }))
}

/** Sum amounts by category for CR or DR. */
export function aggregateByCategory(txns, drCr) {
  const act = (txns || []).filter(t => !t.void && t.drCr === drCr)
  const m = {}
  for (const t of act) {
    const c = t.category || "Uncategorised"
    m[c] = (m[c] || 0) + (Number(t.amount) || 0)
  }
  return Object.entries(m)
    .map(([name, v]) => [name, Math.round(v * 100) / 100])
    .sort((a, b) => b[1] - a[1])
}

/** Roll up journal lines (double-entry) for trial balance. */
export function trialBalanceFromJournal(txns) {
  const map = new Map()
  for (const t of txns || []) {
    if (t.void) continue
    const lines =
      t.journalLines?.length >= 2
        ? t.journalLines
        : buildJournalLines({ amount: t.amount, drCr: t.drCr, category: t.category })
    for (const l of lines) {
      const d = Number(l.debit) || 0
      const c = Number(l.credit) || 0
      const prev = map.get(l.account) || { d: 0, c: 0 }
      map.set(l.account, { d: prev.d + d, c: prev.c + c })
    }
  }
  const rows = [...map.entries()]
    .map(([account, { d, c }]) => ({
      account,
      debit: Math.round(d * 100) / 100,
      credit: Math.round(c * 100) / 100,
    }))
    .sort((x, y) => x.account.localeCompare(y.account))
  const tDr = Math.round(rows.reduce((s, r) => s + r.debit, 0) * 100) / 100
  const tCr = Math.round(rows.reduce((s, r) => s + r.credit, 0) * 100) / 100
  return { rows, tDr, tCr }
}

/** Output GST (est.) from Revenue-* credits @ 18% inclusive CGST+SGST. */
export function estimatedTotalOutputGst(txns) {
  const revCr = (txns || [])
    .filter(t => !t.void && t.drCr === "CR" && String(t.category || "").startsWith("Revenue"))
    .reduce((s, t) => s + (Number(t.amount) || 0), 0)
  const taxable = Math.round((revCr / 1.18) * 100) / 100
  return Math.round((revCr - taxable) * 100) / 100
}

const CAL_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** Indian FY label e.g. 2025-26 → month keys YYYY-MM (Apr–Mar). */
export function fyToMonthOptions(fy) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(fy || "").trim())
  if (!m) return []
  const y1 = Number(m[1])
  const y2 = y1 + 1
  const out = []
  for (let mo = 4; mo <= 12; mo++) out.push({ key: `${y1}-${String(mo).padStart(2, "0")}`, label: `${CAL_MONTHS[mo - 1]} ${y1}` })
  for (let mo = 1; mo <= 3; mo++) out.push({ key: `${y2}-${String(mo).padStart(2, "0")}`, label: `${CAL_MONTHS[mo - 1]} ${y2}` })
  return out
}

export function txnMatchesCalendarMonth(dateDdMmYyyy, yyyyMm) {
  if (!yyyyMm || !dateDdMmYyyy) return true
  const parts = String(yyyyMm).split("-")
  if (parts.length !== 2) return true
  const y = Number(parts[0])
  const mo = Number(parts[1])
  const p = String(dateDdMmYyyy).split("/")
  if (p.length !== 3) return false
  return Number(p[2]) === y && Number(p[1]) === mo
}

/** Distinct FY strings from non-void txns. */
export function distinctFYs(txns) {
  const s = new Set((txns || []).filter(t => !t.void && t.fy).map(t => String(t.fy)))
  return [...s].sort()
}

/**
 * Filter non-void txns for reports: FY (Indian), calendar month (YYYY-MM), optional ISO date range.
 */
export function filterTxnsForReport(txns, { fy, monthKey, fromIso, toIso } = {}) {
  let list = (txns || []).filter(t => !t.void)
  if (fy) list = list.filter(t => t.fy === fy)
  if (monthKey) list = list.filter(t => txnMatchesCalendarMonth(t.date, monthKey))
  if (fromIso) {
    const fromMs = new Date(fromIso + "T00:00:00").getTime()
    list = list.filter(t => parseDdMmYyyy(t.date) >= fromMs)
  }
  if (toIso) {
    const toMs = new Date(toIso + "T23:59:59.999").getTime()
    list = list.filter(t => parseDdMmYyyy(t.date) <= toMs)
  }
  return list
}
