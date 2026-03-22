/**
 * Parse bank CSV (and Excel sheet-as-CSV) into HisaabKitaab transactions.
 * Tries HDFC / ICICI / Axis / SBI style headers (Date, Narration, Withdrawal, Deposit, Balance).
 */

import {
  buildJournalLines,
  inferFY,
  isDuplicateTxn,
  isPeriodLocked,
  parseDdMmYyyy,
  validateBalanced,
} from "./accountingEngine.js"

const IT_SOLUTIONS_VENDOR_RE = /\bIT\s+SOLUTIONS\b/i
const JOB_PORTAL_HINT_RE =
  /naukri|jobhai|work\s*india|workindia|apna\.co|apna\.jobs|apna\s+jobs?|indeed|linkedin|\bshine\b|monster|foundit|hirist|instahyre|glassdoor|iimjobs|cutshort|wellfound|babajob|jobportal|job[\s\/._-]*portal|hiring[\s\/._-]*portal|timesjobs?|freshersworld|headhonchos|placement\s*portal|recruitment\s*portal|simplyhired|ziprecruiter|careerbuilder|seek\.com|naukri\.com|workindia\.com|jobhai\.com/i

/** Common payor name hints in NEFT/IMPS narrations → generic revenue bucket (no client-specific categories). */
const B2B_CREDIT_RES = [
  /credhast/i,
  /wheelseye|wheels\s*eye/i,
  /yellow\s*pedal/i,
  /truck\s*sup/i,
  /value\s*drive/i,
  /shiprocket/i,
  /swapecos/i,
  /pure\s*ride/i,
  /levante/i,
]
const REVENUE_B2B = "Revenue - B2B Services"

/** Narration + remarks (and similar) combined for regex-based category hints. */
export function combineNarrationAndRemarks(narration, remarks) {
  const a = String(narration || "").replace(/\s+/g, " ").trim()
  const b = String(remarks || "").replace(/\s+/g, " ").trim()
  if (a && b) return `${a} ${b}`
  return a || b || ""
}

/** Human-readable particulars when bank sends separate Remarks column. */
export function formatImportParticulars(narration, remarks) {
  const a = String(narration || "").replace(/\s+/g, " ").trim()
  const b = String(remarks || "").replace(/\s+/g, " ").trim()
  if (a && b) return `${a} · Remarks: ${b}`
  if (a) return a
  if (b) return b
  return ""
}

/** Beneficiary bank names at end of Axis/HDFC-style NEFT strings (salary to staff accounts). */
const RETAIL_BANK_BENEFICIARY_RE =
  /(?:STATE BANK OF INDIA|PUNJAB NATIONAL BANK|BANK OF BARODA|BANK OF INDIA|HDFC BANK|HDFC\s+BANK|AXIS BANK|ICICI|CENTRAL BANK OF INDIA|IDBI|FEDERAL|IDFC|KOTAK MAHINDRA|PUNJAB NATIONAL BAN|BANK OF BARODA\/+)/i

const VENDOR_LIKE_DR_RE = /vendor|invoice|consult|prof\.?\s*fee|professional\s*fee|rent|lease|kiraya|tds\s*deduct/i

/**
 * Stronger debit classification from narration (+ optional remarks) — used on import and when normalizing legacy Misc rows.
 * @returns {string|null} App category or null to keep Misc / upstream guess.
 */
export function inferDebitCategoryFromBankText(particulars, bankRemark) {
  const n = combineNarrationAndRemarks(particulars, bankRemark)
  if (!n) return null
  const low = n.toLowerCase()

  if (/\bepfo\b|epfo\s+payment|epf\s+payment|provident\s*fund|esi\s+payment|professional\s*tax\s*pay|pt\s+payment\b/i.test(n)) {
    return "Employer PF / ESI Expense"
  }

  if (VENDOR_LIKE_DR_RE.test(low)) return null

  if (/INB\/NEFT|NEFT\/AXODH|NEFT\/[A-Z]{2,}\d/i.test(n) && RETAIL_BANK_BENEFICIARY_RE.test(n)) {
    return "Salary"
  }
  if (/IMPS\/P2A/i.test(n) && /FEDERAL|HDFC|SBI|AXIS|STATE BANK|SBIN/i.test(n)) {
    return "Salary"
  }

  return null
}

function guessCategory(particulars, drCr) {
  const n = String(particulars || "")
  if (drCr === "CR") {
    for (const re of B2B_CREDIT_RES) {
      if (re.test(n)) return REVENUE_B2B
    }
    if (/income\s*tax|tds\s*refund|it\s*refund|refund.*\bit\b/i.test(n)) return "Income Tax Refund"
    if (/capital|infusion|share\s*application|equity/i.test(n)) return "Capital Infusion - Director"
    if (/neft\s*return|returned|bounce|reversal/i.test(n)) return "NEFT Return"
    return "Misc Income"
  }
  if (IT_SOLUTIONS_VENDOR_RE.test(n)) return "Vendor - IT Solutions"
  if (/consulta|vitra/i.test(n)) return "Vendor - Professional"
  if (/preserve|faciliteez/i.test(n)) return "Vendor - Supplies"
  if (JOB_PORTAL_HINT_RE.test(n)) return "Recruitment - Job Portals"
  const inferred = inferDebitCategoryFromBankText(n, "")
  if (inferred) return inferred
  if (/salary|payroll|staff\s*salary|wages|pf\s*payment|esi/i.test(n)) return "Salary"
  if (/\bdirector\b|remuneration|partner\s*drawing/i.test(n)) return "Director Payment"
  if (/rent|lease|kiraya|landlord/i.test(n)) return "Rent Expense"
  if (/bank\s*charg|nach|ach\s*dr|sms\s*chg|min\s*bal|emi\s*chg|upi.*charg/i.test(n)) return "Bank Charges"
  return "Misc Expense"
}

export function parseCsvToMatrix(text) {
  const rows = []
  let field = ""
  let row = []
  let inQ = false
  const s = String(text || "").replace(/^\uFEFF/, "")
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQ = false
        }
        continue
      }
      field += c
      continue
    }
    if (c === '"') {
      inQ = true
      continue
    }
    if (c === "\r") continue
    if (c === "\n") {
      row.push(field)
      field = ""
      if (row.some(cell => String(cell).trim() !== "")) rows.push(row)
      row = []
      continue
    }
    if (c === "," || c === ";" || c === "\t") {
      row.push(field)
      field = ""
      continue
    }
    field += c
  }
  row.push(field)
  if (row.some(cell => String(cell).trim() !== "")) rows.push(row)
  return rows
}

function normHeader(h) {
  return String(h || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[()[\].]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\./g, "")
    .trim()
}

function findCol(H, keys) {
  for (const k of keys) {
    const i = H.findIndex(h => h === k || h.includes(k))
    if (i >= 0) return i
  }
  return -1
}

/** True if header is the Dr/Cr indicator column (not a rupee amount column). */
function isDebitCreditTypeHeader(h) {
  if (!h) return false
  if (/\bdebit\b.*\bcredit\b|\bcredit\b.*\bdebit\b/.test(h)) return true
  if (/^dr\s*[/|]\s*cr$/i.test(h) || /^cr\s*[/|]\s*dr$/i.test(h)) return true
  return false
}

/** Debit amount column — excludes combined "Debit/Credit" type column. */
function findDebitAmountCol(H) {
  const skip = h => isDebitCreditTypeHeader(h)
  const keys = [
    "withdrawal amt",
    "withdrawal amount",
    "withdrawals dr",
    "withdrawals",
    "withdrawal",
    "debit amount",
    "debits dr",
    "debits",
    "dr amount",
    "money out",
    "paid out",
  ]
  for (const k of keys) {
    const i = H.findIndex(h => !skip(h) && (h === k || h.includes(k)))
    if (i >= 0) return i
  }
  const i = H.findIndex(h => !skip(h) && h === "debit")
  return i
}

/** Credit amount column — excludes combined "Debit/Credit" type column. */
function findCreditAmountCol(H) {
  const skip = h => isDebitCreditTypeHeader(h)
  const keys = [
    "deposit amt",
    "deposit amount",
    "deposits cr",
    "deposits",
    "deposit",
    "credit amount",
    "credits cr",
    "credits",
    "cr amount",
    "money in",
    "received",
  ]
  for (const k of keys) {
    const i = H.findIndex(h => !skip(h) && (h === k || h.includes(k)))
    if (i >= 0) return i
  }
  return H.findIndex(h => !skip(h) && h === "credit")
}

function findAmountCol(H) {
  return H.findIndex(h => {
    if (/closing|opening/.test(h) && /balance/.test(h)) return false
    if (/balance/.test(h) && /available|ledger|closing|running|opening/.test(h)) return false
    if (h === "amount" || h === "transaction amount" || h === "txn amount") return true
    if (h === "amount inr" || /^amount\b/.test(h)) return true
    if (h.endsWith(" amount") && !/balance|withdrawal|deposit|opening|closing/.test(h)) return true
    return false
  })
}

function findDrCrTypeCol(H) {
  const i = H.findIndex(h => isDebitCreditTypeHeader(h))
  if (i >= 0) return i
  return findCol(H, ["dr/cr", "dr cr", "type", "debit/credit", "transaction type", "drcr"])
}

export function parseDateToDdMmYyyy(cell) {
  const raw = String(cell ?? "").trim()
  if (!raw) return null
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const [y, m, d] = raw.split(/[-T\s]/)[0].split("-").map(Number)
    if (!y || !m || !d) return null
    return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`
  }
  const p = raw.split(/[\/\-.]/)
  if (p.length === 3) {
    let d0
    let m0
    let y0
    if (p[0].length === 4) {
      y0 = Number(p[0])
      m0 = Number(p[1])
      d0 = Number(p[2])
    } else {
      d0 = Number(p[0])
      m0 = Number(p[1])
      y0 = Number(p[2])
    }
    if (!Number.isFinite(d0) || !Number.isFinite(m0) || !Number.isFinite(y0)) return null
    if (y0 < 100) y0 += 2000
    return `${String(d0).padStart(2, "0")}/${String(m0).padStart(2, "0")}/${y0}`
  }
  return null
}

/** Excel serial day → dd/mm/yyyy (Excel ↔ 1970-01-01 offset used by SheetJS). */
function excelSerialToDdMmYyyy(serial) {
  const s = Math.floor(Number(serial))
  if (!Number.isFinite(s) || s < 25000 || s > 65000) return null
  const ms = (s - 25569) * 86400000
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return null
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`
}

/** Date cell from bank export (strings, JS Date, Excel serial numbers in raw sheets). */
function parseCellAsStatementDate(cell) {
  if (cell == null || cell === "") return null
  if (Object.prototype.toString.call(cell) === "[object Date]" && !Number.isNaN(cell.getTime())) {
    return `${String(cell.getDate()).padStart(2, "0")}/${String(cell.getMonth() + 1).padStart(2, "0")}/${cell.getFullYear()}`
  }
  if (typeof cell === "number" && Number.isFinite(cell)) {
    const whole = Math.floor(cell)
    const frac = Math.abs(cell - whole)
    if (frac > 0.0001 && frac < 1) {
      const x = excelSerialToDdMmYyyy(whole)
      if (x) return x
    }
    if (frac < 1e-9 && whole >= 25000 && whole <= 65000) {
      const x = excelSerialToDdMmYyyy(whole)
      if (x) return x
    }
  }
  const raw = String(cell).trim()
  if (!raw) return null
  const slash = parseDateToDdMmYyyy(raw)
  if (slash) return slash
  const d = new Date(raw)
  if (!Number.isNaN(d.getTime()) && /[a-z]{3,}/i.test(raw) && raw.length >= 6 && raw.length <= 28) {
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`
  }
  if (/^\d{5}(\.0+)?$/.test(raw)) {
    const x = excelSerialToDdMmYyyy(Math.floor(Number(raw)))
    if (x) return x
  }
  return null
}

export function findStatementHeaderRow(matrix) {
  const max = Math.min(matrix?.length ?? 0, 50)
  for (let i = 0; i < max; i++) {
    const row = matrix[i]
    if (!row || row.length < 3) continue
    const headers = row.map(c => String(c ?? ""))
    const m = mapColumns(headers)
    const hasAmount = m.debit >= 0 || m.credit >= 0 || m.amount >= 0
    if (m.date >= 0 && hasAmount) return i
  }
  return -1
}

function parseAmountCell(cell) {
  if (cell == null || cell === "") return null
  if (typeof cell === "number" && Number.isFinite(cell)) return Math.abs(cell)
  let t = String(cell).trim()
  const parenNeg = /^\(.*\)$/.test(t)
  t = t.replace(/[₹Rsrs,,\s]/gi, "").replace(/[()]/g, "")
  const neg = parenNeg || /^-/.test(String(cell))
  t = t.replace(/^[-+]/, "")
  const n = parseFloat(t)
  if (!Number.isFinite(n)) return null
  return Math.abs(n) * (neg ? -1 : 1)
}

function mapColumns(headers) {
  const H = headers.map(normHeader)
  const dateKeys = [
    "transaction date",
    "tran date",
    "txn date",
    "post date",
    "posting date",
    "value date",
    "value dt",
    "book date",
    "posting dt",
    "date",
  ]
  const narrKeys = [
    "narration",
    "description",
    "particulars",
    "transaction details",
    "details",
    "payee name",
    "counterparty",
    "transaction particulars",
  ]
  const balanceKeys = ["closing balance", "running balance", "balance", "ledger balance"]
  const categoryKeys = ["category", "ledger", "classification"]

  let date = findCol(H, dateKeys)
  if (date < 0) date = H.findIndex(h => /^date\b/.test(h) || (h.includes("date") && !h.includes("update")))

  const narration = findCol(H, narrKeys)
  const remarkKeys = [
    "transaction remarks",
    "txn remarks",
    "remarks",
    "remark",
    "customer remark",
    "bank remark",
    "payee remark",
    "beneficiary remarks",
    "additional remarks",
    "payment remarks",
    "spl instr",
    "special instruction",
    "value date remarks",
  ]
  let remarks = findCol(H, remarkKeys)
  if (remarks >= 0 && remarks === narration) remarks = -1

  return {
    date,
    narration,
    remarks,
    debit: findDebitAmountCol(H),
    credit: findCreditAmountCol(H),
    balance: findCol(H, balanceKeys),
    drCr: findDrCrTypeCol(H),
    category: findCol(H, categoryKeys),
    amount: findAmountCol(H),
  }
}

function rowDrCrAmount(row, m) {
  const debitRaw = m.debit >= 0 ? row[m.debit] : ""
  const creditRaw = m.credit >= 0 ? row[m.credit] : ""
  const w = parseAmountCell(debitRaw)
  const d = parseAmountCell(creditRaw)
  if (w != null && w > 0) return { drCr: "DR", amount: Math.abs(w) }
  if (d != null && d > 0) return { drCr: "CR", amount: Math.abs(d) }
  if (w != null && w < 0) return { drCr: "DR", amount: Math.abs(w) }
  if (d != null && d < 0) return { drCr: "CR", amount: Math.abs(d) }

  if (m.amount >= 0) {
    const signed = parseAmountCell(row[m.amount])
    if (signed == null || signed === 0) return null
    const typ = String(m.drCr >= 0 ? row[m.drCr] ?? "" : "")
      .trim()
      .toLowerCase()
    const amt = Math.abs(signed)
    const t = typ.replace(/\s+/g, " ")
    if (t === "dr" || t === "d" || t === "debit" || /^debit\b/.test(t) || (t.includes("debit") && !t.includes("credit")))
      return { drCr: "DR", amount: amt }
    if (t === "cr" || t === "c" || t === "credit" || /^credit\b/.test(t) || (t.includes("credit") && !t.includes("debit")))
      return { drCr: "CR", amount: amt }
    return { drCr: signed >= 0 ? "CR" : "DR", amount: amt }
  }
  return null
}

/** True when the row was added by a bank file import (`audit.ref` prefix `import:`). */
export function isTxnFromBankFileImport(t) {
  return String(t?.audit?.ref ?? "").startsWith("import:")
}

/**
 * Parse a bank statement matrix into draft rows (before duplicate / period checks).
 * Used for import preview JSON and by `importBankStatementFromMatrix`.
 * @returns {{ ok: true, drafts: object[], bodyRowCount: number } | { ok: false, error: string, headerHint?: string, newTxns: [], stats: object }}
 */
export function bankMatrixToDraftRows(matrix) {
  if (!matrix?.length) return { ok: false, error: "File is empty.", newTxns: [], stats: {} }

  const previewRows = () =>
    matrix
      .slice(0, 8)
      .map(r => (r || []).map(c => String(c).slice(0, 36)).join(" | "))
      .join(" · ")

  let headerIdx = 0
  let headers = (matrix[0] || []).map(c => String(c ?? ""))
  let m = mapColumns(headers)
  let hasAmount = m.debit >= 0 || m.credit >= 0 || m.amount >= 0
  if (m.date < 0 || !hasAmount) {
    headerIdx = findStatementHeaderRow(matrix)
    if (headerIdx < 0) {
      return {
        ok: false,
        error:
          "Could not find header row (Date + Debit/Credit or Amount). Many bank XLSX files have title rows before the table — we scan the first 50 lines. Try re-downloading CSV from net banking, or the template.",
        newTxns: [],
        stats: {},
        headerHint: previewRows().slice(0, 400),
      }
    }
    headers = matrix[headerIdx].map(c => String(c ?? ""))
    m = mapColumns(headers)
    hasAmount = m.debit >= 0 || m.credit >= 0 || m.amount >= 0
    if (m.date < 0 || !hasAmount) {
      return {
        ok: false,
        error: "Found a possible header row but columns did not match (Date + amounts).",
        newTxns: [],
        stats: {},
        headerHint: headers.slice(0, 14).join(" | "),
      }
    }
  }

  const idxs = [m.date, m.narration, m.remarks, m.debit, m.credit, m.balance, m.amount, m.drCr, m.category].filter(
    i => i >= 0
  )
  const maxCol = idxs.length ? Math.max(...idxs) : 0

  const drafts = []
  const body = matrix.slice(headerIdx + 1)
  for (let r = 0; r < body.length; r++) {
    const row = body[r]
    if (!row || !row.length) continue
    while (row.length <= maxCol) row.push("")
    const date = parseCellAsStatementDate(row[m.date])
    if (!date) continue

    const narrRaw =
      m.narration >= 0
        ? String(row[m.narration] ?? "").replace(/\s+/g, " ").trim()
        : ""
    const remRaw = m.remarks >= 0 ? String(row[m.remarks] ?? "").replace(/\s+/g, " ").trim() : ""
    const narrFallback =
      narrRaw ||
      String(row.find((c, i) => i !== m.date && i !== m.remarks && String(c).trim()) ?? "").trim()
    const narr = narrRaw || (m.remarks < 0 ? narrFallback : "")
    const forCategory = combineNarrationAndRemarks(narr || narrFallback, remRaw)
    const particulars =
      formatImportParticulars(narr || narrFallback, remRaw) || narrFallback || "(no narration)"

    const flow = rowDrCrAmount(row, m)
    if (!flow || !flow.amount || flow.amount <= 0) continue

    let category =
      m.category >= 0 ? String(row[m.category] ?? "").trim() : ""
    if (!category) category = guessCategory(forCategory || particulars, flow.drCr)

    let balance = null
    if (m.balance >= 0) {
      const b = parseAmountCell(row[m.balance])
      if (b != null && Number.isFinite(b)) balance = Math.abs(b) * (b < 0 ? -1 : 1)
    }

    drafts.push({
      date,
      particulars,
      bankRemark: remRaw || undefined,
      amount: flow.amount,
      drCr: flow.drCr,
      category,
      balance,
    })
  }

  if (!drafts.length) {
    return {
      ok: false,
      error:
        "No transaction rows parsed. Dates may be in an unsupported format, or amount columns are empty on all rows.",
      newTxns: [],
      stats: { bad: body.length },
      headerHint: `${headers.slice(0, 12).join(" | ")} · ${previewRows().slice(0, 200)}`,
    }
  }

  drafts.sort((a, b) => parseDdMmYyyy(a.date) - parseDdMmYyyy(b.date) || a.particulars.localeCompare(b.particulars))
  return { ok: true, drafts, bodyRowCount: body.length, headerSummary: headers.slice(0, 14).join(" | ") }
}

/**
 * @returns {{ newTxns: object[], stats: object, error?: string, headerHint?: string }}
 */
export function importBankStatementFromMatrix(matrix, ctx) {
  const { txns, periodLockIso, acctRole, fileName } = ctx
  if (acctRole === "Viewer") return { error: "Viewer role cannot import.", newTxns: [], stats: {} }

  const parsed = bankMatrixToDraftRows(matrix)
  if (!parsed.ok) {
    return { error: parsed.error, newTxns: [], stats: parsed.stats || {}, headerHint: parsed.headerHint }
  }
  const { drafts } = parsed

  const active = [...txns.filter(t => !t.void)]
  const baseId = Math.max(0, ...txns.map(t => Number(t.id) || 0))
  const newTxns = []
  const stats = { ok: 0, dup: 0, lock: 0, bad: 0 }

  for (const d of drafts) {
    if (periodLockIso && isPeriodLocked(d.date, periodLockIso)) {
      stats.lock++
      continue
    }
    if (isDuplicateTxn(active, d) || isDuplicateTxn(newTxns, d)) {
      stats.dup++
      continue
    }
    const journalLines = buildJournalLines({ amount: d.amount, drCr: d.drCr, category: d.category })
    const v = validateBalanced(journalLines)
    if (!v.ok) {
      stats.bad++
      continue
    }
    const id = baseId + newTxns.length + 1
    const t = {
      id,
      date: d.date,
      particulars: d.particulars,
      amount: d.amount,
      drCr: d.drCr,
      category: d.category,
      fy: inferFY(d.date),
      journalLines,
      void: false,
      audit: {
        createdAt: new Date().toISOString(),
        createdBy: acctRole,
        ref: `import:${fileName || "statement"}`,
      },
    }
    if (d.bankRemark) t.bankRemark = d.bankRemark
    if (d.balance != null && Number.isFinite(d.balance)) t.balance = d.balance
    newTxns.push(t)
    active.push(t)
    stats.ok++
  }

  const dates = newTxns.map(t => parseDdMmYyyy(t.date)).filter(Boolean)
  const period =
    dates.length > 0
      ? `${new Date(Math.min(...dates)).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })} – ${new Date(Math.max(...dates)).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}`
      : "—"

  return { newTxns, stats, period }
}

export function importBankStatementFromText(csvText, ctx) {
  const matrix = parseCsvToMatrix(csvText)
  return importBankStatementFromMatrix(matrix, ctx)
}

/** Load CSV/Excel into a matrix whose first row is the statement header (preamble stripped for XLSX). */
export async function bankFileToImportMatrix(file) {
  const name = (file.name || "").toLowerCase()
  if (name.endsWith(".csv") || name.endsWith(".txt")) {
    return parseCsvToMatrix(await file.text())
  }
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const XLSX = await import("xlsx")
    const buf = await file.arrayBuffer()
    const wb = XLSX.read(buf, { type: "array", cellDates: true })
    if (!wb.SheetNames?.length) throw new Error("Workbook has no sheets.")

    for (const sn of wb.SheetNames) {
      const sh = wb.Sheets[sn]
      if (!sh) continue
      let matrix = XLSX.utils.sheet_to_json(sh, { header: 1, defval: "", raw: false })
      let hi = findStatementHeaderRow(matrix)
      if (hi < 0) {
        matrix = XLSX.utils.sheet_to_json(sh, { header: 1, defval: "", raw: true })
        hi = findStatementHeaderRow(matrix)
      }
      if (hi >= 0) return matrix.slice(hi)
    }

    const sn0 = wb.SheetNames[0]
    const text = XLSX.utils.sheet_to_csv(wb.Sheets[sn0], { FS: ",", blankrows: false })
    return parseCsvToMatrix(text)
  }
  throw new Error("Use a .csv or .xlsx file from your bank.")
}
