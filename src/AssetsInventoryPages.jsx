/**
 * Fixed asset register / depreciation schedule and stock register / stock statement pages.
 * Shared UI primitives come in through `ui` (they live in App.jsx).
 */

import { useMemo, useState } from "react"
import { ASSET_BLOCKS, blockByKey, defaultBookRate, depreciationSchedule, bookedFixedAssetCost, fyBounds, depreciationRef } from "./fixedAssets.js"
import { stockStatement } from "./inventoryStock.js"
import { parseDdMmYyyy } from "./accountingEngine.js"

const todayIso = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}
const fyOfDate = d => {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`
}
const isoDdMm = iso => {
  const [y, m, d] = String(iso || "").split("-")
  return y && m && d ? `${d}/${m}/${y}` : "—"
}
const fyIsoRange = fy => {
  const b = fyBounds(fy)
  return b ? { from: `${b.y}-04-01`, to: `${b.y + 1}-03-31` } : { from: "", to: "" }
}

function downloadCsv(name, header, rows) {
  const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`
  const body = [header, ...rows].map(r => r.map(esc).join(",")).join("\n")
  const a = document.createElement("a")
  a.href = URL.createObjectURL(new Blob([body], { type: "text/csv" }))
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}

function fyChoices(extraYears = []) {
  const cur = Number(fyOfDate(new Date()).slice(0, 4))
  const ys = new Set([cur + 1, cur, cur - 1, cur - 2, cur - 3, cur - 4, ...extraYears])
  return [...ys]
    .sort((a, b) => b - a)
    .map(y => `${y}-${String((y + 1) % 100).padStart(2, "0")}`)
}

const emptyAsset = () => ({
  id: null,
  name: "",
  block: "computers",
  purchaseDate: todayIso(),
  cost: "",
  method: "SLM",
  rate: String(defaultBookRate("computers", "SLM")),
  residualPct: "5",
  vendor: "",
  invoiceNo: "",
  location: "",
  linkedTxnId: "",
  disposalDate: "",
  disposalValue: "",
})

export function FixedAssetsPage({ ui, assets, txns, acctRole, periodLockIso, onSaveAsset, onDeleteAsset, onPostDepreciation }) {
  const { S, Stat, Tbl, Modal, F, IS, inr0 } = ui
  const [fy, setFy] = useState(() => fyOfDate(new Date()))
  const [basis, setBasis] = useState("books")
  const [draft, setDraft] = useState(null)
  const readOnly = acctRole === "Viewer"

  const sched = useMemo(() => depreciationSchedule(assets, fy, basis), [assets, fy, basis])
  const booked = useMemo(() => bookedFixedAssetCost(txns), [txns])
  const registerCost = useMemo(() => assets.filter(a => !a.disposalDate).reduce((s, a) => s + a.cost, 0), [assets])
  const posted = useMemo(() => (txns || []).find(t => !t.void && t?.audit?.ref === depreciationRef(fy)), [txns, fy])
  const booksDep = useMemo(() => depreciationSchedule(assets, fy, "books").totals.dep, [assets, fy])
  const years = useMemo(() => assets.map(a => Number(String(a.purchaseDate).slice(0, 4))), [assets])

  const draftId = draft?.id ?? null
  const linkedElsewhere = useMemo(() => new Set(assets.filter(a => a.id !== draftId && a.linkedTxnId != null).map(a => String(a.linkedTxnId))), [assets, draftId])
  const payCandidates = useMemo(() => {
    if (!draft) return []
    const cost = Number(draft.cost) || 0
    const list = (txns || []).filter(t => !t.void && t.drCr === "DR" && !t.excludeFromBankRunning && !linkedElsewhere.has(String(t.id)))
    const near = cost > 0 ? list.filter(t => Math.abs(t.amount - cost) <= Math.max(1, cost * 0.2)) : []
    const pool = near.length ? near : list
    return pool
      .sort((a, b) => (cost > 0 ? Math.abs(a.amount - cost) - Math.abs(b.amount - cost) : 0) || parseDdMmYyyy(b.date) - parseDdMmYyyy(a.date))
      .slice(0, 40)
  }, [draft, txns, linkedElsewhere])

  const setD = patch => setDraft(d => ({ ...d, ...patch }))
  const openEdit = a =>
    setDraft({
      ...a,
      cost: String(a.cost),
      rate: String(a.rate),
      residualPct: String(a.residualPct),
      linkedTxnId: a.linkedTxnId == null ? "" : String(a.linkedTxnId),
      disposalValue: a.disposalValue ? String(a.disposalValue) : "",
    })
  const save = () => {
    const ok = onSaveAsset({
      ...draft,
      cost: Number(draft.cost),
      rate: Number(draft.rate),
      residualPct: Number(draft.residualPct),
      linkedTxnId: draft.linkedTxnId === "" ? null : Number(draft.linkedTxnId),
      disposalValue: Number(draft.disposalValue) || 0,
    })
    if (ok) setDraft(null)
  }

  const exportSchedule = () =>
    downloadCsv(
      `fixed_asset_schedule_${fy}_${basis}.csv`,
      ["Asset", "Block", "Purchase date", "Cost", "Method", "Rate %", "Opening WDV", "Additions", "Depreciation", "Disposal (WDV)", "Closing WDV"],
      sched.rows.map(r => [
        r.asset.name,
        r.block.label,
        isoDdMm(r.asset.purchaseDate),
        r.asset.cost,
        basis === "tax" ? "WDV (IT Act)" : r.asset.method,
        basis === "tax" ? r.block.taxRate : r.asset.rate,
        r.opening,
        r.addition,
        r.dep,
        r.disposal,
        r.closing,
      ])
    )

  const lockedFyEnd = periodLockIso && fyBounds(fy) && `${fyBounds(fy).y + 1}-03-31` <= periodLockIso

  return (
    <div>
      <div style={S.g4}>
        <Stat label="Assets in register" value={String(assets.filter(a => !a.disposalDate).length)} sub={`${assets.filter(a => a.disposalDate).length} disposed`} />
        <Stat label="Gross block (cost)" value={"₹" + inr0(registerCost)} sub="Active assets, as per register" />
        <Stat label={`Depreciation FY ${fy}`} value={"₹" + inr0(sched.totals.dep)} sub={basis === "tax" ? "Income Tax Act (WDV block rates)" : "Companies Act (books)"} color="#f43f5e" />
        <Stat label={`Net block 31 Mar ${Number(fy.slice(0, 4)) + 1}`} value={"₹" + inr0(sched.totals.closing)} color="#10b981" />
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <select value={fy} onChange={e => setFy(e.target.value)} style={{ ...S.sel, width: 130 }}>
          {fyChoices(years).map(y => (
            <option key={y} value={y}>
              FY {y}
            </option>
          ))}
        </select>
        <div style={S.tabs}>
          {[
            ["books", "Companies Act (books)"],
            ["tax", "Income Tax Act"],
          ].map(([k, l]) => (
            <button key={k} type="button" onClick={() => setBasis(k)} style={S.tab(basis === k)}>
              {l}
            </button>
          ))}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
          {!readOnly && (
            <button type="button" onClick={() => setDraft(emptyAsset())} style={{ ...S.btn, fontSize: 11, padding: "5px 11px" }}>
              + Add Asset
            </button>
          )}
          <button type="button" onClick={exportSchedule} style={{ ...S.btnO, fontSize: 11, padding: "5px 11px" }}>
            ⬇ Schedule CSV
          </button>
        </div>
      </div>

      <div style={{ ...S.card, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", fontSize: 11.5 }}>
        <div style={{ flex: "1 1 320px", lineHeight: 1.5 }}>
          <strong>Post to ledger:</strong> FY {fy} books depreciation ₹{inr0(booksDep)} → Dr Depreciation Expense / Cr Accumulated Depreciation, dated 31/03/
          {Number(fy.slice(0, 4)) + 1}.{" "}
          {posted ? (
            <span style={{ color: Math.abs(posted.amount - booksDep) < 0.01 ? "#10b981" : "#f59e0b" }}>
              Posted ₹{inr0(posted.amount)}
              {Math.abs(posted.amount - booksDep) < 0.01 ? " — up to date." : " — register changed since, re-post to update."}
            </span>
          ) : (
            <span style={{ color: "#64748b" }}>Not posted yet.</span>
          )}
        </div>
        {!readOnly && (
          <button
            type="button"
            disabled={lockedFyEnd || (booksDep <= 0.005 && !posted)}
            onClick={() => onPostDepreciation(fy)}
            style={{ ...S.btn, fontSize: 11, padding: "6px 12px", opacity: lockedFyEnd || (booksDep <= 0.005 && !posted) ? 0.5 : 1 }}
            title={lockedFyEnd ? "This FY is in a locked period" : ""}
          >
            {posted ? "Re-post depreciation" : "Post depreciation"}
          </button>
        )}
      </div>

      {Math.abs(booked - registerCost) > 0.5 && (
        <div style={{ background: "rgba(245,158,11,.08)", border: "1px solid rgba(245,158,11,.25)", borderRadius: 9, padding: "9px 13px", marginBottom: 12, fontSize: 11.5, color: "#92400e", lineHeight: 1.5 }}>
          Register cost ₹{inr0(registerCost)} vs fixed-asset cost in the ledger ₹{inr0(booked)}. Link each asset to the bank payment that bought it (Edit → “Paid from”), or book bank payments under a
          “Fixed Asset - …” category, so the Balance Sheet and the register agree.
        </div>
      )}

      {sched.byBlock.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <Tbl
            cols={[
              { h: "Block", cell: r => <strong>{r.block.label}</strong> },
              { h: "Rate", cell: r => (r.total ? "" : basis === "tax" ? `${r.block.taxRate}% WDV` : `${r.block.life} yrs life`) },
              { h: "Opening WDV", r: true, mono: true, cell: r => "₹" + inr0(r.opening) },
              { h: "Additions", r: true, mono: true, cell: r => "₹" + inr0(r.addition) },
              { h: "Disposals", r: true, mono: true, cell: r => "₹" + inr0(r.disposal) },
              { h: "Depreciation", r: true, mono: true, cell: r => "₹" + inr0(r.dep) },
              { h: "Closing WDV", r: true, mono: true, cell: r => "₹" + inr0(r.closing) },
            ]}
            rows={[...sched.byBlock, { block: { label: "TOTAL" }, ...sched.totals, total: true }]}
          />
        </div>
      )}

      <Tbl
        cols={[
          {
            h: "Asset",
            cell: r => (
              <div>
                <div style={{ fontWeight: 700, color: "#0c4a6e" }}>{r.asset.name}</div>
                <div style={{ fontSize: 10, color: "#64748b" }}>
                  {r.block.label} · bought {isoDdMm(r.asset.purchaseDate)}
                  {r.asset.disposalDate ? ` · disposed ${isoDdMm(r.asset.disposalDate)}` : ""}
                </div>
              </div>
            ),
          },
          { h: "Cost", r: true, mono: true, cell: r => "₹" + inr0(r.asset.cost) },
          { h: "Method", cell: r => (basis === "tax" ? `WDV ${r.block.taxRate}%` : `${r.asset.method} ${r.asset.rate}%`) },
          { h: "Opening WDV", r: true, mono: true, cell: r => "₹" + inr0(r.opening) },
          { h: "Additions", r: true, mono: true, cell: r => (r.addition ? "₹" + inr0(r.addition) : "—") },
          { h: "Depreciation", r: true, mono: true, cell: r => <span style={{ color: "#f43f5e" }}>₹{inr0(r.dep)}</span> },
          { h: "Disposal", r: true, mono: true, cell: r => (r.disposal ? "₹" + inr0(r.disposal) : "—") },
          { h: "Closing WDV", r: true, mono: true, cell: r => <strong>₹{inr0(r.closing)}</strong> },
          {
            h: "Books",
            cell: r =>
              r.asset.linkedTxnId != null ? (
                <span style={{ fontSize: 10, color: "#10b981" }}>Bank txn #{r.asset.linkedTxnId}</span>
              ) : (
                <span style={{ fontSize: 10, color: "#64748b" }}>Opening entry</span>
              ),
          },
          {
            h: "",
            r: true,
            cell: r =>
              readOnly ? null : (
                <button type="button" onClick={() => openEdit(r.asset)} style={{ ...S.btnO, fontSize: 10, padding: "3px 8px" }}>
                  Edit
                </button>
              ),
          },
        ]}
        rows={sched.rows}
        empty={assets.length ? `No assets in use during FY ${fy}.` : "No fixed assets yet — click + Add Asset (laptops, furniture, vehicles, machinery, software)."}
      />

      <Modal
        open={!!draft}
        title={draft?.id ? "Edit Fixed Asset" : "Add Fixed Asset"}
        onClose={() => setDraft(null)}
        onSave={save}
        saveDisabled={!draft?.name?.trim() || !(Number(draft?.cost) > 0) || !draft?.purchaseDate}
        saveLabel="Save Asset"
        footerLeft={
          draft?.id ? (
            <button
              type="button"
              onClick={() => {
                if (onDeleteAsset(draft.id)) setDraft(null)
              }}
              style={{ ...S.btnO, fontSize: 11, padding: "5px 10px", color: "#f43f5e" }}
            >
              Delete asset
            </button>
          ) : null
        }
      >
        {draft && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: "0 11px" }}>
            <div style={{ gridColumn: "1/-1" }}>
              <F label="Asset name">
                <input value={draft.name} onChange={e => setD({ name: e.target.value })} placeholder='e.g. MacBook Pro 14"' style={IS} />
              </F>
            </div>
            <F label="Asset block">
              <select
                value={draft.block}
                onChange={e => {
                  const block = e.target.value
                  setD({ block, rate: String(defaultBookRate(block, draft.method)), residualPct: String(blockByKey(block).residual) })
                }}
                style={IS}
              >
                {ASSET_BLOCKS.map(b => (
                  <option key={b.key} value={b.key}>
                    {b.label} ({b.life} yrs · IT {b.taxRate}%)
                  </option>
                ))}
              </select>
            </F>
            <F label="Purchase / put-to-use date">
              <input type="date" value={draft.purchaseDate} onChange={e => setD({ purchaseDate: e.target.value })} style={IS} />
            </F>
            <F label="Cost (₹, excl. claimable GST)">
              <input type="number" value={draft.cost} onChange={e => setD({ cost: e.target.value })} placeholder="0" style={IS} />
            </F>
            <F label="Method (books)">
              <select value={draft.method} onChange={e => setD({ method: e.target.value, rate: String(defaultBookRate(draft.block, e.target.value)) })} style={IS}>
                <option value="SLM">SLM — straight line</option>
                <option value="WDV">WDV — written down value</option>
              </select>
            </F>
            <F label="Rate % p.a. (books)">
              <input type="number" value={draft.rate} onChange={e => setD({ rate: e.target.value })} style={IS} />
            </F>
            <F label="Residual value %">
              <input type="number" value={draft.residualPct} onChange={e => setD({ residualPct: e.target.value })} style={IS} />
            </F>
            <F label="Vendor">
              <input value={draft.vendor} onChange={e => setD({ vendor: e.target.value })} style={IS} />
            </F>
            <F label="Invoice no.">
              <input value={draft.invoiceNo} onChange={e => setD({ invoiceNo: e.target.value })} style={IS} />
            </F>
            <div style={{ gridColumn: "1/-1" }}>
              <F label="Paid from (bank transaction)">
                <select value={draft.linkedTxnId} onChange={e => setD({ linkedTxnId: e.target.value })} style={IS}>
                  <option value="">Not in this bank ledger — book as opening entry (Dr asset / Cr Owner capital)</option>
                  {payCandidates.map(t => (
                    <option key={t.id} value={String(t.id)}>
                      #{t.id} · {t.date} · ₹{inr0(t.amount)} · {t.category} · {String(t.particulars || "").slice(0, 50)}
                    </option>
                  ))}
                </select>
              </F>
              <div style={{ fontSize: 10, color: "#64748b", marginTop: -6, marginBottom: 12 }}>
                Linking re-categorises that payment to “{blockByKey(draft.block).category}” so it moves from expenses to the Balance Sheet.
              </div>
            </div>
            <F label="Disposal / sale date (optional)">
              <input type="date" value={draft.disposalDate} onChange={e => setD({ disposalDate: e.target.value })} style={IS} />
            </F>
            <F label="Sale value (₹, for reference)">
              <input type="number" value={draft.disposalValue} onChange={e => setD({ disposalValue: e.target.value })} placeholder="0" style={IS} />
            </F>
            {draft.disposalDate && (
              <div style={{ gridColumn: "1/-1", fontSize: 10.5, color: "#64748b", lineHeight: 1.5 }}>
                On disposal the WDV is written off (Dr Accumulated Depreciation + Loss on Sale, Cr asset). Book the money received as a bank receipt in category “Asset Sale”.
                Post depreciation for the FY of disposal too.
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}

const emptyItem = () => ({ id: null, item: "", hsn: "", group: "Goods", unit: "Nos", openingDate: todayIso(), openingQty: "", openingRate: "", reorderLevel: "", vendor: "" })

export function InventoryPage({ ui, items, acctRole, addOpen, onOpenAdd, onCloseAdd, onSaveItem, onDeleteItem, onAddMovement }) {
  const { S, Stat, Tbl, Modal, F, IS, inr, inr0 } = ui
  const [range, setRange] = useState(() => fyIsoRange(fyOfDate(new Date())))
  const [itemForm, setItemForm] = useState(null)
  const [mv, setMv] = useState(null)
  const readOnly = acctRole === "Viewer"
  const st = useMemo(() => stockStatement(items, range.from, range.to), [items, range])
  const low = st.rows.filter(r => r.status !== "ok").length
  const cur = itemForm || (addOpen ? emptyItem() : null)
  const setF = patch => setItemForm({ ...cur, ...patch })
  const closeItem = () => {
    setItemForm(null)
    onCloseAdd()
  }
  const saveItem = () => {
    const ok = onSaveItem({
      ...cur,
      openingQty: Number(cur.openingQty) || 0,
      openingRate: Number(cur.openingRate) || 0,
      reorderLevel: Number(cur.reorderLevel) || 0,
    })
    if (ok) closeItem()
  }
  const saveMv = () => {
    if (onAddMovement(mv.itemId, { id: Date.now(), date: mv.date, type: mv.type, qty: Number(mv.qty), rate: Number(mv.rate) || 0, note: mv.note })) setMv(null)
  }

  const exportStatement = () =>
    downloadCsv(
      `stock_statement_${range.from || "start"}_${range.to || "today"}.csv`,
      ["Item", "HSN/SAC", "Unit", "Opening qty", "Opening value", "Inward qty", "Inward value", "Outward qty", "Outward value", "Closing qty", "Closing value", "Avg rate"],
      st.rows.map(r => [r.item.item, r.item.hsn, r.item.unit, r.openQty, r.openVal, r.inQty, r.inVal, r.outQty, r.outVal, r.closeQty, r.closeVal, r.avgRate])
    )

  const mvItem = mv && items.find(i => i.id === mv.itemId)

  return (
    <div>
      <div style={S.g4}>
        <Stat label="Items" value={String(items.length)} />
        <Stat label="Opening stock" value={"₹" + inr0(st.totals.openVal)} sub={range.from ? `as on ${isoDdMm(range.from)}` : "from start"} />
        <Stat label="Closing stock" value={"₹" + inr0(st.totals.closeVal)} sub={range.to ? `as on ${isoDdMm(range.to)}` : "till date"} color="#10b981" />
        <Stat label="Low / out of stock" value={String(low)} color={low ? "#f59e0b" : "#94a3b8"} />
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end", marginBottom: 12 }}>
        <F label="From">
          <input type="date" value={range.from} onChange={e => setRange(r => ({ ...r, from: e.target.value }))} style={{ ...IS, width: 150 }} />
        </F>
        <F label="To">
          <input type="date" value={range.to} onChange={e => setRange(r => ({ ...r, to: e.target.value }))} style={{ ...IS, width: 150 }} />
        </F>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, marginBottom: 12 }}>
          {!readOnly && (
            <button type="button" onClick={onOpenAdd} style={{ ...S.btn, fontSize: 11, padding: "5px 11px" }}>
              + Add Item
            </button>
          )}
          <button type="button" onClick={exportStatement} style={{ ...S.btnO, fontSize: 11, padding: "5px 11px" }}>
            ⬇ Stock Statement CSV
          </button>
        </div>
      </div>
      <Tbl
        cols={[
          {
            h: "Item",
            cell: r => (
              <div>
                <div style={{ fontWeight: 700, color: "#0c4a6e" }}>{r.item.item}</div>
                <div style={{ fontSize: 10, color: "#64748b" }}>
                  {r.item.hsn ? `HSN ${r.item.hsn} · ` : ""}
                  {r.item.unit}
                </div>
              </div>
            ),
          },
          { h: "Opening", r: true, mono: true, cell: r => `${r.openQty} · ₹${inr0(r.openVal)}` },
          { h: "Inward", r: true, mono: true, cell: r => <span style={{ color: "#10b981" }}>{`${r.inQty} · ₹${inr0(r.inVal)}`}</span> },
          { h: "Outward", r: true, mono: true, cell: r => <span style={{ color: "#f43f5e" }}>{`${r.outQty} · ₹${inr0(r.outVal)}`}</span> },
          { h: "Closing", r: true, mono: true, cell: r => <strong>{`${r.closeQty} · ₹${inr0(r.closeVal)}`}</strong> },
          { h: "Avg rate", r: true, mono: true, cell: r => "₹" + inr(r.avgRate) },
          {
            h: "Status",
            cell: r => (
              <span style={{ fontSize: 10, fontWeight: 700, color: r.status === "ok" ? "#10b981" : r.status === "low" ? "#f59e0b" : "#f43f5e" }}>
                {r.status === "ok" ? "In stock" : r.status === "low" ? "Low stock" : "Out of stock"}
              </span>
            ),
          },
          {
            h: "",
            r: true,
            cell: r =>
              readOnly ? null : (
                <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                  <button type="button" onClick={() => setMv({ itemId: r.item.id, type: "in", date: todayIso(), qty: "", rate: String(r.avgRate || r.item.openingRate || ""), note: "" })} style={{ ...S.btnO, fontSize: 10, padding: "3px 7px" }}>
                    + In
                  </button>
                  <button type="button" onClick={() => setMv({ itemId: r.item.id, type: "out", date: todayIso(), qty: "", rate: "", note: "" })} style={{ ...S.btnO, fontSize: 10, padding: "3px 7px" }}>
                    − Out
                  </button>
                  <button
                    type="button"
                    onClick={() => setItemForm({ ...r.item, openingQty: String(r.item.openingQty), openingRate: String(r.item.openingRate), reorderLevel: String(r.item.reorderLevel || "") })}
                    style={{ ...S.btnO, fontSize: 10, padding: "3px 7px" }}
                  >
                    Edit
                  </button>
                </div>
              ),
          },
        ]}
        rows={st.rows}
        empty="No stock items yet — click + Add Item, then record purchases (+ In) and sales / consumption (− Out)."
      />
      <div style={{ fontSize: 10, color: "#64748b", marginTop: 8, lineHeight: 1.5 }}>
        Valued at weighted average cost. Closing stock (as on the report date) flows into the Balance Sheet. Laptops, furniture and other long-use items belong in Fixed Assets, not stock.
      </div>

      <Modal
        open={!!cur}
        title={cur?.id ? "Edit Stock Item" : "Add Stock Item"}
        onClose={closeItem}
        onSave={saveItem}
        saveDisabled={!String(cur?.item || "").trim()}
        saveLabel="Save Item"
        footerLeft={
          cur?.id ? (
            <button
              type="button"
              onClick={() => {
                if (onDeleteItem(cur.id)) closeItem()
              }}
              style={{ ...S.btnO, fontSize: 11, padding: "5px 10px", color: "#f43f5e" }}
            >
              Delete item
            </button>
          ) : null
        }
      >
        {cur && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: "0 11px" }}>
            <div style={{ gridColumn: "1/-1" }}>
              <F label="Item name">
                <input value={cur.item} onChange={e => setF({ item: e.target.value })} placeholder="e.g. A4 paper ream" style={IS} />
              </F>
            </div>
            <F label="HSN / SAC code">
              <input value={cur.hsn} onChange={e => setF({ hsn: e.target.value })} style={IS} />
            </F>
            <F label="Unit">
              <select value={cur.unit} onChange={e => setF({ unit: e.target.value })} style={IS}>
                {["Nos", "Pcs", "Kg", "Ltr", "Mtr", "Box", "Set", "Licence"].map(u => (
                  <option key={u}>{u}</option>
                ))}
              </select>
            </F>
            <F label="Opening stock date">
              <input type="date" value={cur.openingDate} onChange={e => setF({ openingDate: e.target.value })} style={IS} />
            </F>
            <F label="Opening quantity">
              <input type="number" value={cur.openingQty} onChange={e => setF({ openingQty: e.target.value })} placeholder="0" style={IS} />
            </F>
            <F label="Opening rate (₹ per unit)">
              <input type="number" value={cur.openingRate} onChange={e => setF({ openingRate: e.target.value })} placeholder="0" style={IS} />
            </F>
            <F label="Re-order level (qty)">
              <input type="number" value={cur.reorderLevel} onChange={e => setF({ reorderLevel: e.target.value })} placeholder="0" style={IS} />
            </F>
            <F label="Vendor">
              <input value={cur.vendor} onChange={e => setF({ vendor: e.target.value })} style={IS} />
            </F>
          </div>
        )}
      </Modal>

      <Modal
        open={!!mv}
        title={mv ? `${mv.type === "in" ? "Stock In" : "Stock Out"} — ${mvItem?.item || ""}` : ""}
        onClose={() => setMv(null)}
        onSave={saveMv}
        saveDisabled={!(Number(mv?.qty) > 0) || !mv?.date || (mv?.type === "in" && !(Number(mv?.rate) >= 0))}
        saveLabel="Save"
      >
        {mv && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 11px" }}>
            <F label="Date">
              <input type="date" value={mv.date} onChange={e => setMv(m => ({ ...m, date: e.target.value }))} style={IS} />
            </F>
            <F label={`Quantity (${mvItem?.unit || ""})`}>
              <input type="number" value={mv.qty} onChange={e => setMv(m => ({ ...m, qty: e.target.value }))} style={IS} />
            </F>
            {mv.type === "in" && (
              <F label="Purchase rate (₹ per unit)">
                <input type="number" value={mv.rate} onChange={e => setMv(m => ({ ...m, rate: e.target.value }))} style={IS} />
              </F>
            )}
            <div style={{ gridColumn: mv.type === "in" ? "auto" : "1/-1" }}>
              <F label="Note (bill no., customer…)">
                <input value={mv.note} onChange={e => setMv(m => ({ ...m, note: e.target.value }))} style={IS} />
              </F>
            </div>
            {mv.type === "out" && <div style={{ gridColumn: "1/-1", fontSize: 10, color: "#64748b" }}>Issued at the current weighted average cost.</div>}
          </div>
        )}
      </Modal>
    </div>
  )
}
