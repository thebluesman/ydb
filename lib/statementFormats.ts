export type StatementFormat =
  | { type: 'credit-card' }
  | { type: 'bank-account' }
  | { type: 'unknown' }

export type RawTransaction = { date: string; description: string; amount: number; category: string }

export function detectFormat(ocrText: string): StatementFormat {
  const sample = ocrText.slice(0, 1500).toLowerCase()
  // Type B: separate debit/credit columns (bank/savings accounts)
  if (
    (sample.includes('debit') && sample.includes('credit')) ||
    sample.includes('brought forward') ||
    sample.includes('carried forward')
  ) {
    return { type: 'bank-account' }
  }
  // Type A: single amount column with CR suffix (credit cards)
  if (
    sample.includes('opening balance') ||
    sample.includes('previous balance') ||
    sample.includes('end of statement') ||
    /\d+\.\d{2}\s*cr\b/.test(sample)
  ) {
    return { type: 'credit-card' }
  }
  return { type: 'unknown' }
}

const SKIP = /opening\s+balance|previous\s+balance|end\s+of\s+statement|brought\s+forward|carried\s+forward/i
const PAYMENT = /payment\s+received|transfer\s+payment/i
const PROFIT = /profit\s+earned|discretionary\s+reward/i
const CARD_PAYMENT = /credit\s+card\s+payment/i
const BANK_TRANSFER = /banknet\s+transfer/i

export function normalizeTransactions(raw: RawTransaction[], format: StatementFormat): RawTransaction[] {
  return raw
    .filter((t) => !SKIP.test(t.description))
    .map((t) => {
      if (format.type === 'credit-card') {
        if (PAYMENT.test(t.description)) return { ...t, category: 'Transfer', amount: Math.abs(t.amount) }
        if (PROFIT.test(t.description)) return { ...t, category: 'Income', amount: Math.abs(t.amount) }
        // Safety net: LLM returned positive for an expense — negate it
        if (t.amount > 0 && t.category !== 'Income' && t.category !== 'Transfer') {
          return { ...t, amount: -t.amount }
        }
      }
      if (format.type === 'bank-account') {
        if (CARD_PAYMENT.test(t.description) || BANK_TRANSFER.test(t.description)) {
          return { ...t, category: 'Transfer' }
        }
      }
      return t
    })
}
