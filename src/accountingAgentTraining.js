/**
 * Enterprise Indian Accounting AI Agent — embedded training (system directive).
 * Used as the assistant’s protocol reference and for future LLM system prompts.
 */

export const ENTERPRISE_ACCOUNTING_AGENT_DIRECTIVE = `You are an enterprise-grade Indian Accounting AI Agent.

You specialize in:
- Bank statement parsing (all Indian formats)
- Invoice processing (XLS, CSV, structured)
- GST compliance (CGST, SGST, IGST)
- TDS detection and reconciliation
- Tally-style double-entry bookkeeping
- Intelligent auto-learning from user corrections

Your goal is to generate 100% accurate, audit-ready, and reconciliation-safe accounting data.

CORE OBJECTIVES:
1. ZERO missing transactions or invoices
2. ZERO duplicate entries
3. 100% accurate debit-credit entries
4. Strict Indian accounting compliance
5. GST and TDS correctness
6. Full bank–invoice reconciliation
7. Continuous self-learning and improvement
8. Maintain audit trail for every decision

INPUT SOURCES:
1) Bank Statements: PDF / CSV / Excel / OCR text; multi-account / multi-bank supported.
2) Invoices: XLS / CSV / structured tables — fields may include Invoice Number, Date, Party Name, GSTIN, Taxable Amount, CGST/SGST/IGST, Total Amount.

PROCESS FLOW (STRICT ORDER):
STEP 1 — DATA INGESTION & VALIDATION: read inputs; remove duplicate rows and blanks; validate dates and numbers; normalize dates to DD-MM-YYYY and currency to ₹ numeric.
STEP 2 — TRANSACTION UNIQUENESS ENGINE: unique IDs — Bank: Date+Amount+Reference+Balance; Invoice: Invoice No+Party+Amount; prevent duplicates; maintain audit trace.
STEP 3 — AUTO-LEARNING RULE ENGINE: check learned_rules; priority: exact keyword, party, regex; apply ledger, type, GST flag, TDS rule; confidence HIGH when matched.
STEP 4 — ADVANCED BANK PARSING: detect UPI (PhonePe, GPay, Paytm), NEFT/IMPS/RTGS, ACH/ECS, ATM, POS/ECOM, charges/interest; extract clean party, payment mode, reference.
STEP 5 — INVOICE PROCESSING ENGINE: extract fields; validate Total = Taxable + GST; identify purchase vs sales.
STEP 6 — INTELLIGENT MATCHING ENGINE: bank↔invoice weighted scoring — amount (highest), party fuzzy, date proximity ±3–7 days, reference; >90% confirmed, 70–90% probable, <70% no match.
STEP 7 — TDS DETECTION & RECONCILIATION: if matched and bank < invoice, difference = invoice − bank; validate TDS rates 1/2/5/10%; sales: Dr Bank received, Dr TDS receivable, Cr debtor full; purchase: Dr expense full, Cr bank paid, Cr TDS payable; GST on full invoice value; else partial payment.
STEP 8 — CLASSIFICATION ENGINE: if no rule — income, expense, transfer, GST payment, TDS, EMI, drawings — using remark intelligence.
STEP 9 — GST ENGINE: purchase Dr expense + input GST Cr party/bank; sales Dr bank/party Cr sales + output GST.
STEP 10 — LEDGER ENGINE (TALLY FORMAT): Bank, Cash, Sales, Purchase, Sundry Debtors/Creditors, GST in/out, expenses, capital/drawings.
STEP 11 — ENTRY GENERATION: strict double-entry; balanced; correct accounts.
STEP 12 — RECONCILIATION ENGINE: opening/closing balance; detect mismatch; total debit = total credit.
STEP 13 — AUTO-LEARNING (ENHANCED): on correction store keyword, party, ledger, type, gst_applicable, tds_rate, pattern_signature, usage_count, confidence; boost frequent rules.
STEP 14 — CONFIDENCE ENGINE: HIGH rule/exact; MEDIUM partial; LOW guess.
STEP 15 — ERROR & EXCEPTION: unknown → suspense; mismatch → flag; missing GST → GST unknown.
STEP 16 — AUDIT TRAIL: per txn store source, rule applied, match score, decision reason.

OUTPUT FORMAT (STRICT JSON): root object with "transactions" array; each item includes transaction_id, date, source (bank/invoice), invoice_no, narration, type, party_name, payment_mode, ledger, debit_account[], credit_account[], amount, gst {cgst,sgst,igst}, tds {applicable,rate,amount}, match_score, status (matched/unmatched/partial), confidence, audit_trail {rule_used, decision}.

STRICT RULES: never skip data; never duplicate; always Indian rules; GST on full invoice; detect TDS when difference suggests it; always audit trail; always balance.

FINAL GOAL: autonomous Indian accounting that reads bank and invoices, applies GST/TDS, reconciles, learns from corrections, produces audit-ready Tally-compatible entries.`

const fmtInr = v => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Number(v) || 0)

function snapLine(s) {
  const n = s?.count ?? 0
  const bal = s?.balance != null ? fmtInr(s.balance) : "—"
  return `**Live ledger (this browser):** **${n}** transactions · running balance hint **₹${bal}** (from your data).`
}

/** Short overview of all protocol steps + strict rules (for chips / “what can you do”). */
export function getAgentSkillsOverviewMarkdown(snap) {
  const s = snap || {}
  return `**Indian Accounting AI Agent — embedded protocol (16 steps)**\n\n${snapLine(s)}\n\n**1** Ingestion & validation · **2** Uniqueness IDs · **3** Learned rules (keyword / party / regex) · **4** Bank parsing (UPI, NEFT, IMPS, etc.) · **5** Invoice extraction & tax check · **6** Bank↔invoice matching scores · **7** TDS when bank ≠ invoice · **8** Classification · **9** GST purchase/sales logic · **10** Tally-style ledgers · **11** Balanced entries · **12** Reconciliation · **13** Learning from corrections · **14** Confidence levels · **15** Suspense / exceptions · **16** Audit trail per decision\n\n**Strict rules:** no skipped rows, no duplicates, GST on **full** invoice, TDS when difference fits standard rates, every decision traceable.\n\n**In this app:** bank **CSV/XLSX** via **Upload bank statement**; invoices via **New invoice**; automation-style rules under **Rules & templates**. **Embedded AI (no API keys):** the assistant is trained on **ENTERPRISE_ACCOUNTING_AGENT_DIRECTIVE** in this app — protocol Q&A, pattern answers, Misc fixes, and your **live ledger** — nothing leaves the browser for “AI” reasoning.`
}

const JSON_SCHEMA_HINT = `**Strict JSON shape (integration):** \`{ schema, generated_at, meta, transactions: [ … ] }\` — **transaction_id**, **date**, **source**, **narration**, **ledger**, **debit_account** / **credit_account**, **amount_inr**, **gst**, **tds**, **audit_trail**.`

/** Pattern-based answers aligned with ENTERPRISE_ACCOUNTING_AGENT_DIRECTIVE (local agent, no API). */
export function matchEnterpriseAgentQuery(msg, snap) {
  const low = String(msg || "").trim().toLowerCase()
  if (!low) return null
  const s = snap || {}

  if (
    low === "list agent skills & protocol" ||
    low === "agent skills" ||
    /^list agent skills/.test(low) ||
    /\b(full protocol|16 steps|enterprise agent protocol|agent training overview)\b/i.test(msg)
  ) {
    return getAgentSkillsOverviewMarkdown(s)
  }

  if (/\bwhat can you do\b/i.test(msg) || /\byour (skills|capabilities)\b/i.test(msg) || /^capabilities$/i.test(low)) {
    return `${getAgentSkillsOverviewMarkdown(s)}\n\nTip: ask **bank vs invoice matching**, **TDS difference**, or **JSON output schema** for detail on one block.`
  }

  if (/\b(show|full|complete)\b.*\b(training|directive|system prompt|protocol)\b/i.test(msg) || /\bembedded training\b/i.test(msg)) {
    const excerpt = ENTERPRISE_ACCOUNTING_AGENT_DIRECTIVE.slice(0, 2800)
    return `**Full enterprise directive (excerpt)** — the complete text is embedded in the app as **ENTERPRISE_ACCOUNTING_AGENT_DIRECTIVE** for audit consistency.\n\n${excerpt}\n\n**…** (${ENTERPRISE_ACCOUNTING_AGENT_DIRECTIVE.length} characters total). Ask about any **STEP 1–16** for a focused explanation.`
  }

  if (/\b(json|structured output|output schema|export.*transaction)/i.test(msg) && /\b(format|schema|structure|transactions)\b/i.test(msg)) {
    return JSON_SCHEMA_HINT
  }

  if (/\b(unique|uniqueness|duplicate|dedupe)\b/i.test(msg) && /\b(bank|invoice|transaction|entry)\b/i.test(msg)) {
    return `**STEP 2 — Uniqueness:** Build stable keys — **bank:** date + amount + reference + balance (where available); **invoice:** invoice no + party + amount. Reject or merge duplicates before posting; keep the key in your **audit trail** so reconciliation is traceable. This app’s ledger also uses duplicate checks when you add lines — always review import previews.`
  }

  if (/\b(auto[- ]?learn|learned.?rules|user correction|correct.*rule)\b/i.test(msg)) {
    return `**STEP 3 & 13 — Learning:** Store mappings from **keyword → ledger/type/GST/TDS** with **party** and optional **regex**; bump priority by **usage_count** after confirmed corrections. Here, use **Rules & templates** for match rules and templates — that’s the practical “learned rules” layer in this build.`
  }

  if (/\b(upi|phonepe|gpay|paytm|neft|imps|rtgs|ach|ecs|atm|pos)\b/i.test(msg) && /\b(bank|parse|narration)\b/i.test(msg)) {
    return `**STEP 4 — Bank parsing:** Classify rail from narration (UPI, NEFT/IMPS/RTGS, ECS/ACH, ATM, POS/ecom, bank charges/interest). Strip noise to get a **clean counterparty** and **reference** for matching (STEP 6). CSV/XLSX from your bank portal works best; **PDF/OCR** is not parsed inside this assistant — convert or export to structured files first.`
  }

  if (/\b(invoice.*process|process.*invoice|validate.*invoice|taxable.*cgst)\b/i.test(msg) || /\btotal\s*=\s*taxable/i.test(low)) {
    return `**STEP 5 — Invoices:** Parse line items and taxes; sanity-check **total ≈ taxable + CGST + SGST** (intra-state) or **+ IGST** (inter-state). Tag **purchase vs sales** before GST engine (STEP 9). Use **New invoice** for sales entries in-app; bulk XLS/CSV invoice import is a roadmap item — structure columns like party, date, taxable, tax splits, total.`
  }

  if (/\b(match.*bank|bank.*invoice|reconcil|match score|70%|90%)\b/i.test(msg) || /\bprobable match\b/i.test(low)) {
    return `**STEP 6 — Matching:** Weight **amount** highest, then **party** (fuzzy), **date** window (±3–7 days), **reference** string. **>90%** treat as confirmed, **70–90%** probable (human review), **<70%** unmatched. Always log **match_score** and reason in **audit_trail** (STEP 16).`
  }

  if (/\btds\b/i.test(msg) && /\b(invoice|bank|difference|partial|received|paid|less than)\b/i.test(msg)) {
    return `**STEP 7 — TDS vs invoice:** If **bank < invoice** on a matched pair, test **difference** against **1%, 2%, 5%, 10%** (verify live rates/notifications). **Sales:** Dr **Bank** (received), Dr **TDS receivable** (deducted), Cr **Debtor** (gross invoice). **Purchase:** Dr **Expense** (gross), Cr **Bank** (paid), Cr **TDS payable**. **GST** is on the **full invoice value** per your policy; if it doesn’t fit TDS, flag **partial payment**.`
  }

  if (/\b(classif|income|expense|transfer|emi|drawings)\b/i.test(msg) && /\b(no rule|remark|narration)\b/i.test(msg)) {
    return `**STEP 8 — Classification:** If no learned rule hits, bucket by narration into **income, expense, inter-bank transfer, GST payment, TDS, EMI, drawings**. When unsure, **STEP 15** → **Suspense** until the user confirms.`
  }

  if (/\bgst engine\b/i.test(low) || (/\b(input|output)\s*gst\b/i.test(low) && /\bpurchase|sales\b/i.test(msg))) {
    return `**STEP 9 — GST:** **Purchase:** Dr expense, Dr **input GST**, Cr creditor/bank. **Sales:** Dr bank/debtor, Cr **sales**, Cr **output GST** (CGST/SGST or IGST per place of supply). Your ledger **output GST (est.)** from live data: **₹${fmtInr(s.gstEst)}**.`
  }

  if (/\bledger engine|tally.?style|sundry debtor|sundry creditor\b/i.test(msg)) {
    return `**STEP 10 — Ledgers:** Maintain **Bank, Cash, Sales, Purchase, Sundry Debtors/Creditors, Input/Output GST, major expenses, Capital/Drawings**. Map every line to the chart you use consistently for audit and Tally export alignment.`
  }

  if (/\b(entry generation|balanced entries|sigma.*debit|σdr)\b/i.test(msg) || (/\bdouble[- ]entry\b/i.test(msg) && /\bstrict|engine\b/i.test(msg))) {
    return `**STEP 11:** Every voucher balances (**ΣDr = ΣCr**). Multi-leg entries (GST, TDS) must still close to zero difference per voucher.`
  }

  if (/\bopening balance|closing balance|trial balance\b/i.test(msg) && /\breconcil|mismatch\b/i.test(msg)) {
    return `**STEP 12 — Reconciliation:** Tie **opening + movements** to **closing** bank/ledger; if mismatch, trace **missing txn, duplicate, or wrong date**. Trial balance must balance before you trust P&L/Balance sheet.`
  }

  if (/\bconfidence\b/i.test(msg) && /\b(high|medium|low|match)\b/i.test(msg)) {
    return `**STEP 14 — Confidence:** **HIGH** = rule or exact match; **MEDIUM** = partial / fuzzy; **LOW** = default guess — require human confirmation before posting.`
  }

  if (/\b(suspense|unknown account|gst unknown|exception engine)\b/i.test(msg)) {
    return `**STEP 15:** Post unclear items to **Suspense** (or tag **GST unknown**) instead of silently wrong ledgers; clear suspense with a reversing/adjusting entry once identified.`
  }

  if (/\baudit trail\b/i.test(msg) || /\bdecision reason\b/i.test(msg)) {
    return `**STEP 16 — Audit trail:** For each row store **source** (bank file / invoice id), **rule_used**, **match_score**, and **decision** text. Bank imports in this app tag **import:…** references so you can trace and bulk-remove imports if needed.`
  }

  if (/\bstrict rules\b/i.test(msg) || /\b100% accurate\b/i.test(msg) || /\bzero duplicate\b/i.test(msg)) {
    return `**Strict operating rules (protocol):** Do not skip rows; eliminate duplicates via uniqueness keys; keep **GST on full invoice**; investigate **TDS** when amounts differ; maintain **audit trail**; never post unbalanced vouchers. I apply this mindset in explanations; actual posting is always **your confirm** in this UI.`
  }

  if (
    /\b(smart\s+journal|text\s+to\s+journal|journal\s+from\s+text|natural\s+language\s+journal|hinglish|hindi).*\b(journal|entry|json)\b/i.test(
      msg
    ) ||
    /\bhow\s+do\s+i\s+(post|book)\s+from\s+(chat|text)/i.test(msg)
  ) {
    return `**Smart journal (embedded, no API):** Describe the line in **English / Hindi / Hinglish** with an amount (**₹**, rs, or **k** = thousand, e.g. **20k**). **Expense** cues: paid, diya, kharcha. **Income** cues: received, mila. **Categories:** rent → **Rent Expense**; **salary received** → **Salary Income**; **salary paid** → **Salary**; electricity → **Electricity Expense**; food → **Food Expense**; travel → **Travel Expense**. **Date** defaults to **today**. I reply with **JSON only** (double-entry vs bank), then a **confirm** card if you want to post.`
  }

  return null
}

/** One-line reminders aligned with ENTERPRISE_ACCOUNTING_AGENT_DIRECTIVE (steps 1–16). */
const PROTOCOL_STEP_LINE = [
  "STEP 1 — Ingestion & validation: clean rows, DD-MM-YYYY dates, ₹ amounts, drop blanks.",
  "STEP 2 — Uniqueness: stable keys for bank/invoice rows; block duplicates before posting.",
  "STEP 3 — Learned rules: keyword / party / regex → ledger, GST, TDS (use **Rules & templates** here).",
  "STEP 4 — Bank parsing: detect UPI, NEFT/IMPS/RTGS, ECS, ATM, POS from narration.",
  "STEP 5 — Invoices: fields + sanity-check taxable vs GST vs total; tag purchase vs sales.",
  "STEP 6 — Matching: score bank↔invoice (amount, party, date ±days, reference).",
  "STEP 7 — TDS: if bank < invoice on a match, test 1/2/5/10% style differences; split Dr/Cr correctly.",
  "STEP 8 — Classification: income, expense, transfer, GST/TDS/EMI/drawings from remarks if no rule.",
  "STEP 9 — GST engine: purchase vs sales; input vs output GST with correct Dr/Cr pattern.",
  "STEP 10 — Ledgers: Bank, sales, debtors/creditors, GST, expenses — Tally-style mapping.",
  "STEP 11 — Entries: every voucher **ΣDr = ΣCr**.",
  "STEP 12 — Reconciliation: opening + movements = closing; fix missing/duplicate/wrong date.",
  "STEP 13 — Learning: boost rules from confirmed corrections (automation rules in-app).",
  "STEP 14 — Confidence: HIGH/MEDIUM/LOW — confirm before posting when LOW.",
  "STEP 15 — Exceptions: suspense / GST unknown instead of wrong ledgers.",
  "STEP 16 — Audit trail: source, rule, match score, decision on every row.",
]

function explainProtocolStep(n) {
  if (!Number.isFinite(n) || n < 1 || n > 16) return null
  const line = PROTOCOL_STEP_LINE[n - 1]
  return `**${line}**\n\nAsk **List agent skills & protocol** for the full 16-step overview, or a focused question (e.g. matching, TDS, JSON export).`
}

/**
 * Extra embedded “AI” behaviours (no API): Misc listing, protocol steps, then caller falls through to rules.
 * @param {string} msg
 * @param {{ txns?: object[] }} ctx
 * @returns {string | null}
 */
export function tryEmbeddedAgentHelp(msg, ctx) {
  const low = String(msg || "").trim().toLowerCase()
  if (!low) return null
  const txns = ctx?.txns

  if (
    /\b(list|show|display|what are)\b.*\b(misc|miscellaneous)\b/i.test(msg) ||
    /\bmisc\s+(lines|transactions|txns|entries)\b/i.test(low) ||
    low === "list misc" ||
    /\bshow\s+me\s+misc\b/i.test(low)
  ) {
    const pool = Array.isArray(txns)
      ? txns.filter(t => !t.void && (t.category === "Misc Income" || t.category === "Misc Expense"))
      : []
    const last = pool.slice(-25)
    if (!last.length) {
      return `Misc: कोई लाइन नहीं।`
    }
    const lines = last
      .map(
        t =>
          `#${t.id} ${t.date} ${t.drCr} ₹${fmtInr(t.amount)} ${t.category} · ${String(t.particulars || "").slice(0, 60)}`
      )
      .join("\n")
    return `Misc (25):\n${lines}`
  }

  const stepAsk =
    /\b(?:explain|describe|what\s+is)\s+step\s*(\d{1,2})\b/i.exec(msg) ||
    /^\s*step\s*(\d{1,2})\s*[.:]?\s*$/i.exec(msg) ||
    /\babout\s+step\s*(\d{1,2})\b/i.exec(msg)
  if (stepAsk) {
    const n = parseInt(stepAsk[1], 10)
    const t = explainProtocolStep(n)
    if (t) return t
    return `There is **no STEP ${stepAsk[1]}** in the 16-step protocol — use numbers **1–16**. Say **List agent skills & protocol**.`
  }

  return null
}
