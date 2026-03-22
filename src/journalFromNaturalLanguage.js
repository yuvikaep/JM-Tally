/**
 * Embedded "smart agent": Hindi / Hinglish / English → balanced bank journal JSON.
 * No external APIs — rules trained from product spec below.
 */

import { BANK_ACCOUNT, buildJournalLines, categoryToNominalAccount } from "./accountingEngine.js"

function todayISO() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

/** ₹ / rs / bare numbers; supports k = thousand (20k, 2.5k). */
export function parseAmountFromText(text) {
  const s = String(text || "")
  const kMatch = s.match(/\b(\d+(?:\.\d+)?)\s*k\b/i)
  if (kMatch) {
    const n = parseFloat(kMatch[1])
    if (Number.isFinite(n) && n > 0) return Math.round(n * 1000 * 100) / 100
  }
  const rupee = s.match(/(?:₹|rs\.?|rupees?|inr)\s*([\d,]+(?:\.\d{1,2})?)/i)
  if (rupee) {
    const n = parseFloat(rupee[1].replace(/,/g, ""))
    if (Number.isFinite(n) && n > 0) return Math.round(n * 100) / 100
  }
  const bare = s.match(/\b([\d,]+(?:\.\d{1,2})?)\s*(?:₹|rs\.?)?\b/i)
  if (bare) {
    const n = parseFloat(bare[1].replace(/,/g, ""))
    if (Number.isFinite(n) && n > 0) return Math.round(n * 100) / 100
  }
  return null
}

function detectFlow(text) {
  const low = String(text || "").toLowerCase()
  const income =
    /\b(received|receiv|mila|mile|aaya|aayi|aaye|credit\s+in|incoming|deposit\s+from)\b/i.test(low) ||
    /मिला|मिली|आया|आयी|प्राप्त/i.test(text)
  const expense =
    /\b(paid|pay|payment|diya|diye|kharcha|spent|expense|debited|purchase|buy)\b/i.test(low) ||
    /दिया|खर्च|भेजा|भुगतान/i.test(text)
  if (income && !expense) return "income"
  if (expense && !income) return "expense"
  if (income && expense) {
    const iPos = low.search(/\b(received|mila|aaya|aayi)\b|मिला|आया/)
    const ePos = low.search(/\b(paid|diya|kharcha)\b|दिया|खर्च/)
    if (iPos >= 0 && ePos >= 0) return iPos < ePos ? "income" : "expense"
    if (ePos >= 0) return "expense"
    if (iPos >= 0) return "income"
  }
  return null
}

/**
 * Keyword → app category (must exist in CATS).
 * salary + income → Salary Income; salary + expense → Salary
 */
function detectCategory(text, flow) {
  const low = String(text || "").toLowerCase()
  const isIncome = flow === "income"

  if (/rent|kiraya|किराया|lease|landlord/i.test(low)) {
    return isIncome ? "Misc Income" : "Rent Expense"
  }
  if (/salary|payroll|तनख्वाह|वेतन/i.test(low)) {
    return isIncome ? "Salary Income" : "Salary"
  }
  if (/electric|bijli|बिजली|power\s*bill|light\s*bill/i.test(low)) return "Electricity Expense"
  if (/food|khana|खाना|meal|canteen|lunch|dinner|grocery|swiggy|zomato/i.test(low)) return "Food Expense"
  if (/travel|yatra|flight|train|cab|uber|ola|taxi|petrol|diesel|conveyance|hotel/i.test(low)) return "Travel Expense"

  return isIncome ? "Misc Income" : "Misc Expense"
}

function shortNarration(text, category) {
  const t = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
  return t || category
}

function shouldTryJournalIntent(msg) {
  const amt = parseAmountFromText(msg)
  if (amt == null || amt <= 0) return false
  if (detectFlow(msg) != null) return true
  if (
    /rent|salary|electric|food|travel|kiraya|bijli|khana|mila|diya|paid|received|journal|entry|kharcha/i.test(msg)
  )
    return true
  return false
}

/**
 * @returns {{ ok: true, jsonString: string, draft: { amt: number, desc: string, type: string, cat: string, dateIso: string } } | { ok: false }}
 */
export function journalFromNaturalLanguageToJson(userText, options = {}) {
  const dateIso = options.dateIso || todayISO()
  const text = String(userText || "").trim()
  const amount = parseAmountFromText(text)
  if (amount == null || amount <= 0) return { ok: false }

  let flow = detectFlow(text)
  if (!flow) flow = "expense"

  const category = detectCategory(text, flow)
  const drCr = flow === "income" ? "CR" : "DR"
  const journalLines = buildJournalLines({ amount, drCr, category })
  const nominal = categoryToNominalAccount(category)
  const narration = shortNarration(text, category)

  const payload = {
    date: dateIso,
    amount_inr: Math.round(amount * 100) / 100,
    flow,
    category,
    narration,
    double_entry: journalLines.map(l => ({
      account: l.account,
      debit: l.debit,
      credit: l.credit,
    })),
    bank_account: BANK_ACCOUNT,
    nominal_account: nominal,
    posting: {
      bank_side: drCr,
      particulars_suggestion: narration,
    },
  }

  return {
    ok: true,
    jsonString: JSON.stringify(payload),
    draft: {
      amt: Math.round(amount * 100) / 100,
      desc: narration,
      type: drCr,
      cat: category,
      dateIso,
    },
  }
}

/**
 * Used by chat: only when message looks like a journal description with an amount.
 */
export function tryNaturalLanguageJournal(userText, options = {}) {
  if (!shouldTryJournalIntent(userText)) return null
  const r = journalFromNaturalLanguageToJson(userText, options)
  if (!r.ok) return null
  return r
}

/**
 * User paid output GST / GSTR-3B — book a bank payment (Dr expense, Cr bank) after confirm.
 * Amount from ₹ in message, else options.gstEstFallback (ledger output GST estimate).
 */
export function tryGstPaymentJournalFromChat(userText, options = {}) {
  const text = String(userText || "").trim()
  if (!text) return null
  const low = text.toLowerCase()

  const gstIntent =
    /\b(gst|output\s+gst|cgst|sgst|igst)\b/i.test(text) ||
    /\bgstr\s*[-]?\s*3b\b/i.test(low) ||
    /\bgstr\b/i.test(low)

  const paidIntent =
    /\b(paid|mark\s+paid|payment\s+done|deposited|challan)\b/i.test(text) ||
    /\bpay\s+kar|कर\s+दिया|भुगतान|चुका|चुकाया/i.test(text) ||
    (/\b(done|paid)\b/i.test(low) && /\b(payment|gstr|gst|3b)\b/i.test(low)) ||
    (/\bpayment\b/i.test(low) && /\bdone\b/i.test(low))

  if (!gstIntent || !paidIntent) return null

  let amt = parseAmountFromText(text)
  if (amt == null || amt <= 0) {
    const g = Number(options.gstEstFallback)
    if (Number.isFinite(g) && g > 0) amt = Math.round(g * 100) / 100
  }
  if (amt == null || amt <= 0) return null

  return {
    draft: {
      amt,
      desc: "GST payment — GSTR-3B / output tax deposit",
      type: "DR",
      cat: "GST Payment (Output Tax)",
      dateIso: options.dateIso || todayISO(),
    },
  }
}
