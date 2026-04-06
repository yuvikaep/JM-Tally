/**
 * Parse pasted salary sheets: tab or pipe separated, optional header row.
 * Columns: Employee name | Amount | Type (e.g. Salary) | Date
 */

const MONTHS = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
}

function pad2(n) {
  return String(n).padStart(2, "0")
}

/** @returns {string|null} YYYY-MM-DD */
export function parseHumanDateToIso(s) {
  const t = String(s || "")
    .trim()
    .replace(/\s+/g, " ")
  if (!t) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t
  const iso = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/)
  if (iso) return `${iso[1]}-${pad2(iso[2])}-${pad2(iso[3])}`
  const dmy = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/)
  if (dmy) {
    let y = dmy[3]
    if (y.length === 2) y = `20${y}`
    return `${y}-${pad2(dmy[2])}-${pad2(dmy[1])}`
  }
  const m = t.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/)
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()]
    if (mo) return `${m[3]}-${pad2(mo)}-${pad2(m[1])}`
  }
  return null
}

function parseAmount(raw) {
  const s = String(raw ?? "")
    .replace(/[₹,\s]/g, "")
    .trim()
  if (!s) return NaN
  const n = parseFloat(s)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN
}

/** Map type column to app category (must exist in CATS). */
export function mapSalaryTypeToCategory(type, defaultCat = "Salary") {
  const t = String(type || "")
    .trim()
    .toLowerCase()
  if (t.includes("director")) return "Director Payment"
  if (t.includes("misc")) return "Misc Expense"
  if (t.includes("pf") || t.includes("esi")) return "Employer PF / ESI Expense"
  if (t.includes("salary") || !t) return "Salary"
  return defaultCat
}

function splitLine(line) {
  const t = line.trim()
  if (!t) return []
  if (t.includes("\t")) return t.split(/\t/).map(c => c.trim())
  if (t.includes("|")) return t.split("|").map(c => c.trim())
  const commaParts = t.split(",")
  if (commaParts.length >= 4) {
    const name = commaParts[0].trim()
    const amount = commaParts[1].trim()
    const typ = commaParts[2].trim()
    const datePart = commaParts.slice(3).join(",").trim()
    return [name, amount, typ, datePart]
  }
  return t.split(/\s{2,}/).map(c => c.trim())
}

function looksLikeHeader(cells) {
  const joined = cells.join(" ").toLowerCase()
  return (
    /name|employee|emp|staff/.test(joined) &&
    /amount|salary|gross|net/.test(joined) &&
    (cells.length >= 3 || /date|type/.test(joined))
  )
}

/**
 * @returns {{ ok: true, rows: Array<{ name: string, amount: number, category: string, dateIso: string }>, warnings: string[] } | { ok: false, error: string, warnings?: string[] }}
 */
export function parseBulkSalaryPaste(text, options = {}) {
  const defaultDateIso = options.defaultDateIso || null
  const defaultCategory = options.defaultCategory || "Salary"
  const raw = String(text || "").trim()
  if (!raw) return { ok: false, error: "Paste is empty." }

  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  if (!lines.length) return { ok: false, error: "No lines to parse." }

  let start = 0
  const firstCells = splitLine(lines[0])
  if (firstCells.length >= 3 && looksLikeHeader(firstCells)) start = 1

  const rows = []
  const warnings = []

  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    const cells = splitLine(line)
    if (cells.length < 2) {
      warnings.push(`Line ${i + 1}: skipped (need at least name and amount).`)
      continue
    }

    let name, amountStr, typeStr, dateStr

    if (cells.length >= 4) {
      ;[name, amountStr, typeStr, dateStr] = cells
    } else if (cells.length === 3) {
      name = cells[0]
      amountStr = cells[1]
      const c2 = cells[2]
      if (parseHumanDateToIso(c2)) {
        typeStr = defaultCategory
        dateStr = c2
      } else {
        typeStr = c2
        dateStr = defaultDateIso || ""
      }
    } else {
      name = cells[0]
      amountStr = cells[1]
      typeStr = defaultCategory
      dateStr = defaultDateIso || ""
    }

    const amount = parseAmount(amountStr)
    if (!Number.isFinite(amount) || amount <= 0) {
      warnings.push(`Line ${i + 1}: bad amount "${amountStr}".`)
      continue
    }

    const category = mapSalaryTypeToCategory(typeStr, defaultCategory)
    let dateIso = parseHumanDateToIso(dateStr)
    if (!dateIso) dateIso = defaultDateIso
    if (!dateIso) {
      warnings.push(`Line ${i + 1} (${name}): no valid date — use default or fix.`)
      continue
    }

    const n = String(name || "").trim()
    if (!n) {
      warnings.push(`Line ${i + 1}: missing name.`)
      continue
    }

    rows.push({
      name: n,
      amount,
      category,
      dateIso,
    })
  }

  if (!rows.length) return { ok: false, error: "Could not parse any valid rows. Use tabs between columns: Name, Amount, Type, Date.", warnings }

  return { ok: true, rows, warnings }
}

/**
 * Map parsed rows to ChatConfirmCard / addTxnBatchFromChat entry shape.
 */
export function bulkSalaryRowsToConfirmEntries(rows, narrationPrefix = "Salary —") {
  return rows.map(r => ({
    amt: r.amount,
    desc: `${narrationPrefix} ${r.name}`.replace(/\s+/g, " ").trim(),
    type: "DR",
    cat: r.category,
    dateIso: r.dateIso,
  }))
}
