/**
 * Stock register: items with opening stock + inward / outward movements,
 * valued at weighted average cost. Produces the period stock statement
 * (opening, inward, outward, closing — qty and value) per item.
 */

const r2 = n => Math.round((Number(n) || 0) * 100) / 100
const r3 = n => Math.round((Number(n) || 0) * 1000) / 1000

const isoMs = iso => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""))
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : NaN
}

/** Accepts old rows `{ item, hsn, qty, unitVal, status }` and current ones. */
export function normalizeInventory(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(r => r && String(r.item || "").trim())
    .map((r, i) => ({
      id: r.id ?? `itm_${i + 1}`,
      item: String(r.item).trim(),
      hsn: String(r.hsn || ""),
      group: String(r.group || r.category || "Goods"),
      unit: String(r.unit || "Nos"),
      openingDate: isoMs(r.openingDate) ? r.openingDate : isoMs(r.purchaseDate) ? r.purchaseDate : "",
      openingQty: Number(r.openingQty ?? r.qty) || 0,
      openingRate: Number(r.openingRate ?? r.unitVal) || 0,
      reorderLevel: Number(r.reorderLevel) || 0,
      vendor: String(r.vendor || ""),
      movements: (Array.isArray(r.movements) ? r.movements : [])
        .filter(m => m && isoMs(m.date) && Number(m.qty) > 0)
        .map(m => ({
          id: m.id,
          date: m.date,
          type: m.type === "out" ? "out" : "in",
          qty: Number(m.qty),
          rate: Number(m.rate) || 0,
          note: String(m.note || ""),
        })),
    }))
}

/** Running weighted-average position of one item up to `toMs` (inclusive), split at `fromMs`. */
function itemPosition(item, fromMs, toMs) {
  let qty = 0
  let value = 0
  const pos = { openQty: 0, openVal: 0, inQty: 0, inVal: 0, outQty: 0, outVal: 0 }
  const events = []
  const openAt = isoMs(item.openingDate)
  if (item.openingQty > 0) events.push({ ms: Number.isFinite(openAt) ? openAt : -Infinity, type: "in", qty: item.openingQty, rate: item.openingRate, opening: true })
  for (const m of item.movements) events.push({ ms: isoMs(m.date), ...m })
  events.sort((a, b) => a.ms - b.ms || (a.type === "in" ? -1 : 1))
  let opened = false
  for (const e of events) {
    if (e.ms > toMs) break
    // Opening stock dated on the first day of the period is that period's opening, not an inward.
    const inPeriod = e.opening ? e.ms > fromMs : e.ms >= fromMs
    if (!opened && inPeriod) {
      pos.openQty = qty
      pos.openVal = value
      opened = true
    }
    if (e.type === "in") {
      const v = e.qty * e.rate
      qty += e.qty
      value += v
      if (inPeriod) {
        pos.inQty += e.qty
        pos.inVal += v
      }
    } else {
      const avg = qty > 0 ? value / qty : 0
      const q = Math.min(e.qty, Math.max(qty, 0))
      const v = q * avg
      qty -= e.qty
      value = Math.max(0, value - v)
      if (inPeriod) {
        pos.outQty += e.qty
        pos.outVal += v
      }
    }
  }
  if (!opened) {
    pos.openQty = qty - pos.inQty + pos.outQty
    pos.openVal = value - pos.inVal + pos.outVal
  }
  return {
    openQty: r3(pos.openQty),
    openVal: r2(pos.openVal),
    inQty: r3(pos.inQty),
    inVal: r2(pos.inVal),
    outQty: r3(pos.outQty),
    outVal: r2(pos.outVal),
    closeQty: r3(qty),
    closeVal: r2(qty > 0 ? value : 0),
    avgRate: qty > 0 ? r2(value / qty) : 0,
  }
}

/**
 * Stock statement for [fromIso, toIso]; blank bounds mean "from the beginning" / "till date".
 */
export function stockStatement(items, fromIso, toIso) {
  const fromMs = isoMs(fromIso)
  const toMs = isoMs(toIso)
  const from = Number.isFinite(fromMs) ? fromMs : -Infinity
  const to = Number.isFinite(toMs) ? toMs + 86399999 : Infinity
  const rows = (items || []).map(it => {
    const p = itemPosition(it, from, to)
    const status = p.closeQty <= 0 ? "out" : it.reorderLevel > 0 && p.closeQty <= it.reorderLevel ? "low" : "ok"
    return { item: it, ...p, status }
  })
  const sum = k => r2(rows.reduce((s, r) => s + r[k], 0))
  return {
    rows,
    totals: { openVal: sum("openVal"), inVal: sum("inVal"), outVal: sum("outVal"), closeVal: sum("closeVal") },
  }
}

const dayBefore = iso => {
  const ms = isoMs(iso)
  if (!Number.isFinite(ms)) return ""
  const d = new Date(ms - 86400000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

/** Opening stock entered in the register (value) dated on or before `toIso`. */
function broughtInValue(items, toIso) {
  const to = isoMs(toIso)
  return r2(
    (items || [])
      .filter(it => !Number.isFinite(to) || !isoMs(it.openingDate) || isoMs(it.openingDate) <= to)
      .reduce((s, it) => s + it.openingQty * it.openingRate, 0)
  )
}

/**
 * Stock figures for the balance sheet as on `asOfIso`, with the current period starting `fyStartIso`.
 * Register opening stock is capital brought in; the rest of the stock change is profit (trading account).
 */
export function stockForBalanceSheet(items, asOfIso, fyStartIso) {
  const prevEnd = fyStartIso ? dayBefore(fyStartIso) : ""
  const closing = stockStatement(items, "", asOfIso).totals.closeVal
  const broughtIn = broughtInValue(items, asOfIso)
  const priorClosing = prevEnd ? stockStatement(items, "", prevEnd).totals.closeVal : 0
  const priorBroughtIn = prevEnd ? broughtInValue(items, prevEnd) : 0
  return { closing, broughtIn, priorChange: r2(priorClosing - priorBroughtIn) }
}
