/**
 * Month-wise GST settlement: output GST for the month vs what settled it — bank payments,
 * ITC set-off and payments from cash / director / another account — and what is still pending.
 * Stateless: forms live in App (nested page components there remount on every render).
 */

import { GST_OTHER_SOURCES, GST_SETOFF_ITC, gstPeriodOf, isGstAdjustmentTxn } from "./accountingEngine.js"
import { gstMonthLabel, monthSortKey, r2 } from "./gstMonthly.js"

export function GstSettlementPanel({ ui, rows, acctRole, onAdd, onMovePayment, onDelete, portalBalances, onOpenPortal, onFundingSource, fundingSource, fundingOptions }) {
  const { S, Stat, Tbl, inr0 } = ui
  const ro = acctRole === "Viewer"
  const portal = rows.some(r => r.portal)
  const tot = k => r2(rows.reduce((s, r) => s + r[k], 0))
  const pending = tot("pending")
  const monthOptions = rows.map(r => r.month)
  const money = (v, c) => <span style={{ fontFamily: "monospace", color: c }}>₹{inr0(v)}</span>
  return (
    <div>
      <div style={{ ...S.g4, marginBottom: 12 }}>
        <Stat label="Output GST (all months)" value={"₹" + inr0(tot("gst"))} color="#6B7AFF" />
        {portal ? (
          <>
            <Stat label="ITC utilised (portal)" value={"₹" + inr0(tot("itc"))} sub={`Unused ITC ₹${inr0(portalBalances?.itcBalance)}`} color="#10b981" />
            <Stat label="Cash utilised (portal)" value={"₹" + inr0(tot("other"))} sub={`Cash ledger balance ₹${inr0(portalBalances?.cashBalance)}`} color="#0d9488" />
          </>
        ) : (
          <>
            <Stat label="Paid from bank" value={"₹" + inr0(tot("bank"))} color="#0d9488" />
            <Stat label="ITC set-off + paid other" value={"₹" + inr0(r2(tot("itc") + tot("other")))} sub={`ITC ₹${inr0(tot("itc"))} · other ₹${inr0(tot("other"))}`} color="#10b981" />
          </>
        )}
        <Stat label={pending >= 0 ? "Pending" : "Excess paid"} value={"₹" + inr0(Math.abs(pending))} color={pending > 0.5 ? "#f43f5e" : "#10b981"} />
      </div>
      <div style={{ ...S.card, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", fontSize: 11.5, lineHeight: 1.5 }}>
        <div style={{ flex: "1 1 320px" }}>
          {portal ? (
            <>
              <strong>Settled as per GST portal ledgers.</strong> Cash deposited on portal ₹{inr0(portalBalances?.deposited)} · paid from this bank ₹{inr0(portalBalances?.bankDeposits)} ·{" "}
              <strong style={{ color: portalBalances?.outsideBank > 0.5 ? "#b45309" : "#047857" }}>deposited from outside this bank ₹{inr0(portalBalances?.outsideBank)}</strong>
            </>
          ) : (
            <>Paste your GST portal Electronic Credit / Cash Ledger month-wise summary to settle each month exactly as the portal did (ITC + cash utilised).</>
          )}
        </div>
        {!ro && portal && portalBalances?.outsideBank > 0.5 && (
          <select value={fundingSource || ""} onChange={e => onFundingSource(e.target.value)} style={{ ...S.sel, width: 260, fontSize: 11 }}>
            <option value="">Outside-bank deposits: source not booked yet</option>
            {fundingOptions.map(([k, label]) => (
              <option key={k} value={k}>
                Paid via: {label}
              </option>
            ))}
          </select>
        )}
        {!ro && (
          <button type="button" onClick={onOpenPortal} style={{ ...S.btn, fontSize: 11, padding: "6px 12px" }}>
            {portal ? "Update portal ledger" : "Import GST portal ledger"}
          </button>
        )}
      </div>
      <Tbl
        cols={[
          { h: "Month", cell: r => <strong style={{ fontFamily: "monospace" }}>{gstMonthLabel(r.month)}</strong> },
          { h: "Taxable", r: true, cell: r => money(r.taxable) },
          { h: "Output GST", r: true, cell: r => money(r.gst, "#6B7AFF") },
          ...(portal
            ? [
                { h: "ITC credited", r: true, cell: r => money(r.itcCredited, "#64748b") },
                { h: "Cash deposited", r: true, cell: r => money(r.deposited, "#64748b") },
                { h: "ITC used", r: true, cell: r => money(r.itc, "#10b981") },
                { h: "Cash used", r: true, cell: r => money(r.other, "#0d9488") },
              ]
            : [
                { h: "Bank", r: true, cell: r => money(r.bank, "#0d9488") },
                { h: "ITC", r: true, cell: r => money(r.itc, "#10b981") },
                { h: "Cash / other", r: true, cell: r => money(r.other, "#10b981") },
              ]),
          {
            h: "Pending",
            r: true,
            cell: r => (
              <strong style={{ fontFamily: "monospace", color: r.pending > 0.5 ? "#f43f5e" : r.pending < -0.5 ? "#f59e0b" : "#10b981" }}>
                {r.pending < -0.5 ? "−" : ""}₹{inr0(Math.abs(r.pending))}
              </strong>
            ),
          },
          {
            h: "Running",
            r: true,
            cell: r => (
              <span style={{ fontFamily: "monospace", color: r.running > 0.5 ? "#be123c" : r.running < -0.5 ? "#b45309" : "#047857" }}>
                {r.running < -0.5 ? "−" : ""}₹{inr0(Math.abs(r.running))}
              </span>
            ),
          },
          {
            h: "",
            r: true,
            cell: r =>
              ro || portal ? null : (
                <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                  <button type="button" onClick={() => onAdd(r.month, "itc", Math.max(0, r.pending))} style={{ ...S.btnO, fontSize: 10, padding: "3px 7px" }}>
                    + ITC
                  </button>
                  <button type="button" onClick={() => onAdd(r.month, "other", Math.max(0, r.pending))} style={{ ...S.btnO, fontSize: 10, padding: "3px 7px" }}>
                    + Paid other
                  </button>
                </div>
              ),
          },
        ]}
        rows={rows}
        empty="No GST months yet."
      />

      {portal ? (
        <div style={{ fontSize: 10.5, color: "#64748b", marginTop: 8, lineHeight: 1.5 }}>
          Pending = output GST of the month (from invoices) − ITC used − cash used, as filed on the portal. Running carries excess / shortfall across months. Books: ITC credited Dr ITC
          Receivable / Cr ITC Claimed on Purchases · ITC used Dr GST / Cr ITC Receivable · deposit Dr Electronic Cash Ledger / Cr clearing · cash used Dr GST / Cr Electronic Cash Ledger.
          Bank GST payments clear the clearing account; the rest is booked to the source you pick above.
        </div>
      ) : (
      <>
      <div style={{ fontSize: 12, fontWeight: 700, margin: "16px 0 8px" }}>Payments & set-offs (which month they settle)</div>
      <Tbl
        cols={[
          { h: "Date", k: "date" },
          {
            h: "How",
            cell: t =>
              isGstAdjustmentTxn(t) ? (t.category === GST_SETOFF_ITC ? "ITC set-off" : `Paid — ${GST_OTHER_SOURCES[t.gstSource]?.label || "other"}`) : "Bank",
          },
          { h: "Remark / narration", cell: t => <span style={{ fontSize: 11, color: "#64748b" }}>{String(t.gstRemark || t.particulars || "").slice(0, 70)}</span> },
          { h: "Amount", r: true, cell: t => money(t.amount) },
          {
            h: "For month",
            cell: t =>
              ro || isGstAdjustmentTxn(t) ? (
                gstMonthLabel(gstPeriodOf(t))
              ) : (
                <select value={gstPeriodOf(t)} onChange={e => onMovePayment(t.id, e.target.value)} style={{ ...S.sel, width: 120, fontSize: 11, padding: "3px 6px" }}>
                  {[...new Set([gstPeriodOf(t), ...monthOptions])].map(k => (
                    <option key={k} value={k}>
                      {gstMonthLabel(k)}
                    </option>
                  ))}
                </select>
              ),
          },
          {
            h: "",
            r: true,
            cell: t =>
              !ro && isGstAdjustmentTxn(t) ? (
                <button type="button" onClick={() => onDelete(t.id)} style={{ ...S.btnO, fontSize: 10, padding: "3px 7px", color: "#f43f5e" }}>
                  Remove
                </button>
              ) : null,
          },
        ]}
        rows={rows.flatMap(r => r.items).sort((a, b) => monthSortKey(gstPeriodOf(a)) - monthSortKey(gstPeriodOf(b)))}
        empty="No GST payments recorded yet."
      />
      <div style={{ fontSize: 10.5, color: "#64748b", marginTop: 8, lineHeight: 1.5 }}>
        Bank GST payments count against the month before they were paid (GSTR-3B is due by the 20th) — change “For month” if a payment belongs elsewhere. ITC set-off books Dr GST /
        Cr ITC Claimed on Purchases (purchases were expensed gross); “Paid other” books Dr GST / Cr Cash, Director loan or Other bank, so the books stay balanced.
      </div>
      </>
      )}
    </div>
  )
}

