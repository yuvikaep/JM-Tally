/**
 * Fixed asset register + depreciation schedule (Indian FY, April–March).
 *
 * Two bases:
 *  - "books"  — Companies Act 2013, Schedule II: useful life, 5% residual, SLM or WDV, pro-rata by days.
 *  - "tax"    — Income Tax Act block rates (WDV), half rate when put to use < 180 days in the year of purchase.
 * Books basis is what gets posted to the ledger (Dr Depreciation Expense / Cr Accumulated Depreciation).
 */

import { buildJournalLines, inferFY } from "./accountingEngine.js"

const r2 = n => Math.round((Number(n) || 0) * 100) / 100
const DAY = 86400000

/** Companies Act useful life (years), residual %, and IT Act block rate (%). */
export const ASSET_BLOCKS = [
  { key: "computers", label: "Computers & IT Equipment", category: "Fixed Asset - Computers", account: "Fixed Assets – Computer & IT Equipment", life: 3, residual: 5, taxRate: 40 },
  { key: "furniture", label: "Furniture & Fixtures", category: "Fixed Asset - Furniture", account: "Fixed Assets – Furniture & Fixtures", life: 10, residual: 5, taxRate: 10 },
  { key: "office", label: "Office Equipment", category: "Fixed Asset - Office Equipment", account: "Fixed Assets – Office Equipment", life: 5, residual: 5, taxRate: 15 },
  { key: "plant", label: "Plant & Machinery", category: "Fixed Asset - Plant & Machinery", account: "Fixed Assets – Plant & Machinery", life: 15, residual: 5, taxRate: 15 },
  { key: "vehicles", label: "Vehicles", category: "Fixed Asset - Vehicles", account: "Fixed Assets – Vehicles", life: 8, residual: 5, taxRate: 15 },
  { key: "software", label: "Software / Intangibles", category: "Fixed Asset - Software", account: "Intangible Assets – Software / Licences", life: 3, residual: 0, taxRate: 25 },
]

export const blockByKey = key => ASSET_BLOCKS.find(b => b.key === key) || ASSET_BLOCKS[0]

/** Default annual rate (%) for a block and method under Companies Act. */
export function defaultBookRate(blockKey, method) {
  const b = blockByKey(blockKey)
  const res = b.residual / 100
  if (method === "WDV" && res > 0) return r2((1 - Math.pow(res, 1 / b.life)) * 100)
  return r2(((1 - res) / b.life) * 100)
}

const isoToMs = iso => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""))
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : NaN
}

/** FY "2025-26" → start/end timestamps (1 Apr 2025 … 31 Mar 2026). */
export function fyBounds(fy) {
  const m = /^(\d{4})-\d{2}$/.exec(String(fy || ""))
  if (!m) return null
  const y = Number(m[1])
  return { start: new Date(y, 3, 1).getTime(), end: new Date(y + 1, 2, 31).getTime(), y }
}

export const fyOfIso = iso => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""))
  return m ? inferFY(`${m[3]}/${m[2]}/${m[1]}`) : null
}

const nextFy = fy => {
  const y = Number(String(fy).slice(0, 4)) + 1
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`
}

export function normalizeFixedAssets(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(a => a && a.name && Number(a.cost) > 0 && isoToMs(a.purchaseDate))
    .map(a => {
      const block = blockByKey(a.block).key
      const method = a.method === "WDV" ? "WDV" : "SLM"
      return {
        id: a.id,
        name: String(a.name).trim(),
        block,
        purchaseDate: a.purchaseDate,
        cost: r2(a.cost),
        method,
        rate: Number(a.rate) > 0 ? r2(a.rate) : defaultBookRate(block, method),
        residualPct: Number.isFinite(Number(a.residualPct)) ? Number(a.residualPct) : blockByKey(block).residual,
        vendor: String(a.vendor || ""),
        invoiceNo: String(a.invoiceNo || ""),
        location: String(a.location || ""),
        linkedTxnId: a.linkedTxnId ?? null,
        disposalDate: isoToMs(a.disposalDate) ? a.disposalDate : "",
        disposalValue: r2(a.disposalValue),
      }
    })
}

/** Days the asset was in use inside [start, end] (inclusive), stopping the day before disposal. */
function daysInUse(a, start, end) {
  const from = Math.max(start, isoToMs(a.purchaseDate))
  const disp = isoToMs(a.disposalDate)
  const to = Number.isFinite(disp) ? Math.min(end, disp - DAY) : end
  return to < from ? 0 : Math.round((to - from) / DAY) + 1
}

/**
 * Year-by-year movement of one asset up to and including `uptoFy`.
 * @returns {Map<string, {opening, addition, dep, disposal, closing, accDep}>}
 */
export function assetYears(a, uptoFy, basis = "books") {
  const out = new Map()
  const firstFy = fyOfIso(a.purchaseDate)
  if (!firstFy || !fyBounds(uptoFy) || firstFy > uptoFy) return out
  const floor = basis === "tax" ? 0 : r2((a.cost * (a.residualPct || 0)) / 100)
  const rate = basis === "tax" ? blockByKey(a.block).taxRate : a.rate
  let wdv = 0
  let accDep = 0
  let gone = false
  for (let fy = firstFy; fy <= uptoFy; fy = nextFy(fy)) {
    const { start, end } = fyBounds(fy)
    const opening = wdv
    const addition = fy === firstFy ? a.cost : 0
    if (gone) {
      out.set(fy, { opening: 0, addition: 0, dep: 0, disposal: 0, closing: 0, accDep })
      continue
    }
    const base = opening + addition
    const disp = isoToMs(a.disposalDate)
    const disposedNow = Number.isFinite(disp) && disp >= start && disp <= end
    let dep = 0
    if (basis === "tax") {
      // IT Act: no depreciation in the year of sale; half rate if used < 180 days in year of purchase.
      if (!disposedNow) {
        const half = fy === firstFy && daysInUse(a, start, end) < 180
        dep = (base * rate) / 100 / (half ? 2 : 1)
      }
    } else {
      const totalDays = Math.round((end - start) / DAY) + 1
      const share = daysInUse(a, start, end) / totalDays
      dep = (a.method === "WDV" ? (base * rate) / 100 : (a.cost * rate) / 100) * share
    }
    dep = r2(Math.max(0, Math.min(dep, base - floor)))
    accDep = r2(accDep + dep)
    let closing = r2(base - dep)
    let disposal = 0
    if (disposedNow) {
      disposal = closing
      closing = 0
      gone = true
    }
    wdv = closing
    out.set(fy, { opening: r2(opening), addition, dep, disposal, closing, accDep })
  }
  return out
}

/**
 * Depreciation schedule for one FY: per-asset rows + totals per block.
 */
export function depreciationSchedule(assets, fy, basis = "books") {
  const rows = []
  for (const a of assets || []) {
    const y = assetYears(a, fy, basis).get(fy)
    if (!y) continue
    if (!y.opening && !y.addition && !y.closing && !y.disposal) continue
    rows.push({ ...y, asset: a, block: blockByKey(a.block) })
  }
  const sum = k => r2(rows.reduce((s, r) => s + r[k], 0))
  const byBlock = ASSET_BLOCKS.map(b => {
    const rs = rows.filter(r => r.block.key === b.key)
    const s = k => r2(rs.reduce((t, r) => t + r[k], 0))
    return { block: b, count: rs.length, opening: s("opening"), addition: s("addition"), dep: s("dep"), disposal: s("disposal"), closing: s("closing") }
  }).filter(b => b.count)
  return {
    rows,
    byBlock,
    totals: { opening: sum("opening"), addition: sum("addition"), dep: sum("dep"), disposal: sum("disposal"), closing: sum("closing") },
  }
}

export const DEPRECIATION_CATEGORY = "Depreciation"
export const depreciationRef = fy => `depr:${fy}`

/**
 * Non-bank ledger row booking a FY's books depreciation (posted on 31 March).
 * Replaces any earlier posting for the same FY so re-posting is safe.
 */
export function depreciationTxnForFy(txns, assets, fy, actor) {
  const { totals } = depreciationSchedule(assets, fy, "books")
  const amount = totals.dep
  const ref = depreciationRef(fy)
  const kept = (txns || []).filter(t => t?.audit?.ref !== ref)
  if (amount <= 0.005) return { txns: kept, amount: 0 }
  const { y } = fyBounds(fy)
  const date = `31/03/${y + 1}`
  const id = Math.max(0, ...kept.map(t => Number(t.id) || 0)) + 1
  const t = {
    id,
    date,
    particulars: `Depreciation for FY ${fy} (Companies Act, as per fixed asset register)`,
    amount,
    drCr: "DR",
    category: DEPRECIATION_CATEGORY,
    fy,
    excludeFromBankRunning: true,
    journalLines: [
      { account: "Depreciation Expense", debit: amount, credit: 0 },
      { account: "Accumulated Depreciation", debit: 0, credit: amount },
    ],
    void: false,
    audit: { createdAt: new Date().toISOString(), createdBy: actor, ref },
  }
  return { txns: [...kept, t], amount }
}

export const assetOpeningRef = id => `fa:${id}:open`
export const assetDisposalRef = id => `fa:${id}:disp`
export const isFixedAssetSystemTxn = t => /^(fa:|depr:)/.test(String(t?.audit?.ref || ""))

const isoToDdMmYyyy = iso => {
  const [y, m, d] = String(iso).split("-")
  return `${d}/${m}/${y}`
}

/**
 * Ledger rows a register asset owns (besides its linked bank payment, if any):
 *  - opening row when it was not paid from this bank ledger: Dr asset / Cr Owner / Director Capital
 *  - disposal row when sold / scrapped: Dr Accumulated Depreciation + Loss on Sale, Cr asset (cost)
 * Sale proceeds are a normal bank receipt in category "Asset Sale".
 */
export function assetSystemTxns(a, nextId, actor) {
  const block = blockByKey(a.block)
  const out = []
  const audit = ref => ({ createdAt: new Date().toISOString(), createdBy: actor, ref })
  if (a.linkedTxnId == null) {
    const date = isoToDdMmYyyy(a.purchaseDate)
    out.push({
      id: nextId + out.length,
      date,
      particulars: `Fixed asset brought into books — ${a.name}`,
      amount: a.cost,
      drCr: "DR",
      category: block.category,
      fy: inferFY(date),
      excludeFromBankRunning: true,
      journalLines: [
        { account: block.account, debit: a.cost, credit: 0 },
        { account: "Owner / Director Capital", debit: 0, credit: a.cost },
      ],
      void: false,
      audit: audit(assetOpeningRef(a.id)),
    })
  }
  if (a.disposalDate) {
    const fy = fyOfIso(a.disposalDate)
    const y = assetYears(a, fy, "books").get(fy)
    const accDep = y ? y.accDep : 0
    const wdv = r2(a.cost - accDep)
    const date = isoToDdMmYyyy(a.disposalDate)
    const lines = [{ account: "Accumulated Depreciation", debit: accDep, credit: 0 }]
    if (wdv > 0.005) lines.push({ account: "Loss on Sale of Assets", debit: wdv, credit: 0 })
    lines.push({ account: block.account, debit: 0, credit: a.cost })
    out.push({
      id: nextId + out.length,
      date,
      particulars: `Fixed asset disposed — ${a.name} (WDV written off; sale proceeds booked separately as Asset Sale)`,
      amount: wdv,
      drCr: "DR",
      category: "Asset Disposal",
      fy,
      excludeFromBankRunning: true,
      journalLines: lines.filter(l => l.debit > 0.005 || l.credit > 0.005),
      void: false,
      audit: audit(assetDisposalRef(a.id)),
    })
  }
  return out
}

/** Replace the system rows of one asset in the ledger (pass `null` asset to just remove them). */
export function syncAssetSystemTxns(txns, assetId, asset, actor) {
  const refs = new Set([assetOpeningRef(assetId), assetDisposalRef(assetId)])
  const kept = (txns || []).filter(t => !refs.has(t?.audit?.ref))
  if (!asset) return kept
  const nextId = Math.max(0, ...kept.map(t => Number(t.id) || 0)) + 1
  return [...kept, ...assetSystemTxns(asset, nextId, actor)]
}

/** Ledger cost of fixed assets booked through "Fixed Asset - …" categories (for register ↔ books check). */
export function bookedFixedAssetCost(txns) {
  const accounts = new Set(ASSET_BLOCKS.map(b => b.account))
  let cost = 0
  for (const t of txns || []) {
    if (t.void) continue
    const lines = t.journalLines?.length >= 2 ? t.journalLines : buildJournalLines(t)
    for (const l of lines) {
      if (accounts.has(l.account)) cost += (Number(l.debit) || 0) - (Number(l.credit) || 0)
    }
  }
  return r2(cost)
}

