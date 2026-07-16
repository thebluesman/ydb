import { describe, expect, it } from 'vitest'
import { detectFormat, normalizeTransactions, type RawTransaction, type StatementFormat } from '@/lib/statementFormats'

// Table-driven coverage for lib/statementFormats.ts (IMPROVEMENT_PLAN Phase 8)
// — previously untested despite subtle branching: format detection order
// (bank-account is checked before credit-card, so a statement with both sets
// of keywords resolves to bank-account), the credit-card "safety net" sign
// flip, and the payment/profit/transfer keyword matchers.

describe('detectFormat', () => {
  const cases: Array<[string, string, StatementFormat['type']]> = [
    ['debit + credit columns => bank-account', 'Date Description Debit Credit Balance\n01/01 Coffee 5.00 1000.00', 'bank-account'],
    ['"brought forward" => bank-account', 'Balance brought forward 500.00', 'bank-account'],
    ['"carried forward" => bank-account', 'Balance carried forward 500.00', 'bank-account'],
    ['"opening balance" => credit-card', 'Opening Balance 100.00', 'credit-card'],
    ['"previous balance" => credit-card', 'Previous Balance 100.00', 'credit-card'],
    ['"end of statement" => credit-card', 'Some text ... End of Statement', 'credit-card'],
    ['"123.45 CR" suffix => credit-card', 'Payment received 123.45 CR', 'credit-card'],
    ['no recognisable markers => unknown', 'Just some random text with numbers 12345', 'unknown'],
    ['case-insensitive matching', 'OPENING BALANCE 100.00', 'credit-card'],
    // Precedence: bank-account keywords checked first, so when both sets of
    // markers appear, bank-account wins even though "opening balance" alone
    // would resolve to credit-card.
    ['both bank + credit-card markers => bank-account wins (checked first)', 'Debit Credit columns, Opening Balance 100.00', 'bank-account'],
    // Only the first 1500 chars are inspected.
    ['markers beyond the 1500-char sample window are ignored', 'x'.repeat(1500) + 'Opening Balance 100.00', 'unknown'],
  ]

  for (const [name, text, expected] of cases) {
    it(name, () => {
      expect(detectFormat(text).type).toBe(expected)
    })
  }
})

function raw(description: string, amount: number): RawTransaction {
  return { date: '2024-01-01', description, amount, category: '' }
}

describe('normalizeTransactions — credit-card format', () => {
  const format: StatementFormat = { type: 'credit-card' }

  it('drops SKIP rows (opening/previous balance, end of statement, brought/carried forward)', () => {
    const rows = [
      raw('OPENING BALANCE', 0),
      raw('Previous Balance', 100),
      raw('End of Statement', 0),
      raw('Balance Brought Forward', 50),
      raw('Balance Carried Forward', 50),
      raw('STARBUCKS COFFEE', -5),
    ]
    const result = normalizeTransactions(rows, format)
    expect(result).toHaveLength(1)
    expect(result[0].description).toBe('STARBUCKS COFFEE')
  })

  it('"payment received" => transfer, amount forced positive (abs)', () => {
    const result = normalizeTransactions([raw('PAYMENT RECEIVED - THANK YOU', -500)], format)
    expect(result[0]).toMatchObject({ transactionType: 'transfer', amount: 500 })
  })

  it('"transfer payment" => transfer, amount forced positive', () => {
    const result = normalizeTransactions([raw('TRANSFER PAYMENT', -250)], format)
    expect(result[0]).toMatchObject({ transactionType: 'transfer', amount: 250 })
  })

  it('a payment description that is already positive stays positive (abs is a no-op)', () => {
    const result = normalizeTransactions([raw('PAYMENT RECEIVED', 500)], format)
    expect(result[0]).toMatchObject({ transactionType: 'transfer', amount: 500 })
  })

  it('"profit earned" => credit, category forced to Income, amount forced positive', () => {
    const result = normalizeTransactions([raw('PROFIT EARNED THIS MONTH', -75)], format)
    expect(result[0]).toMatchObject({ transactionType: 'credit', category: 'Income', amount: 75 })
  })

  it('"discretionary reward" => credit, category Income', () => {
    const result = normalizeTransactions([raw('DISCRETIONARY REWARD BONUS', 30)], format)
    expect(result[0]).toMatchObject({ transactionType: 'credit', category: 'Income', amount: 30 })
  })

  it('safety net: an ordinary positive amount (LLM sign error) is negated and typed debit', () => {
    const result = normalizeTransactions([raw('AMAZON MARKETPLACE', 42)], format)
    expect(result[0]).toMatchObject({ transactionType: 'debit', amount: -42 })
  })

  it('an ordinary negative amount stays a debit, unchanged', () => {
    const result = normalizeTransactions([raw('AMAZON MARKETPLACE', -42)], format)
    expect(result[0]).toMatchObject({ transactionType: 'debit', amount: -42 })
  })

  it('zero amount does not trigger the safety net (0 > 0 is false) and stays debit', () => {
    const result = normalizeTransactions([raw('SOME FEE', 0)], format)
    expect(result[0]).toMatchObject({ transactionType: 'debit', amount: 0 })
  })

  it('sets originalDescription to the raw (pre-normalization) description', () => {
    const result = normalizeTransactions([raw('  Coffee Shop  ', -5)], format)
    expect(result[0].originalDescription).toBe('  Coffee Shop  ')
  })

  it('a PAYMENT match takes precedence over the safety net even if amount is positive', () => {
    // Regression: PAYMENT is checked before the safety net, so a positive
    // payment amount must not additionally get debit-negated.
    const result = normalizeTransactions([raw('PAYMENT RECEIVED', 500)], format)
    expect(result[0].transactionType).toBe('transfer')
  })
})

describe('normalizeTransactions — bank-account format', () => {
  const format: StatementFormat = { type: 'bank-account' }

  it('"credit card payment" => transfer, amount unchanged', () => {
    const result = normalizeTransactions([raw('CREDIT CARD PAYMENT', -300)], format)
    expect(result[0]).toMatchObject({ transactionType: 'transfer', amount: -300 })
  })

  it('"banknet transfer" => transfer, amount unchanged', () => {
    const result = normalizeTransactions([raw('BANKNET TRANSFER TO SAVINGS', 1000)], format)
    expect(result[0]).toMatchObject({ transactionType: 'transfer', amount: 1000 })
  })

  it('positive amount, no transfer keyword => credit', () => {
    const result = normalizeTransactions([raw('SALARY PAYMENT INC', 5000)], format)
    expect(result[0]).toMatchObject({ transactionType: 'credit', amount: 5000 })
  })

  it('negative amount, no transfer keyword => debit', () => {
    const result = normalizeTransactions([raw('TESCO STORES', -20)], format)
    expect(result[0]).toMatchObject({ transactionType: 'debit', amount: -20 })
  })

  it('zero amount is treated as credit (amount >= 0)', () => {
    const result = normalizeTransactions([raw('ZERO FEE WAIVED', 0)], format)
    expect(result[0]).toMatchObject({ transactionType: 'credit', amount: 0 })
  })

  it('still drops SKIP rows for bank-account format', () => {
    const result = normalizeTransactions([raw('Carried Forward', 500), raw('Rent', -900)], format)
    expect(result).toHaveLength(1)
    expect(result[0].description).toBe('Rent')
  })

  it('the credit-card-only PAYMENT/PROFIT keywords do NOT trigger transfer/income here', () => {
    const result = normalizeTransactions([raw('PAYMENT RECEIVED - THANK YOU', -500)], format)
    // Under bank-account rules this is just an ordinary negative-amount row.
    expect(result[0]).toMatchObject({ transactionType: 'debit', amount: -500 })
  })
})

describe('normalizeTransactions — unknown format', () => {
  const format: StatementFormat = { type: 'unknown' }

  it('falls back to sign-based typing: positive => credit', () => {
    const result = normalizeTransactions([raw('MYSTERY DEPOSIT', 100)], format)
    expect(result[0]).toMatchObject({ transactionType: 'credit', amount: 100 })
  })

  it('falls back to sign-based typing: negative => debit', () => {
    const result = normalizeTransactions([raw('MYSTERY CHARGE', -100)], format)
    expect(result[0]).toMatchObject({ transactionType: 'debit', amount: -100 })
  })

  it('does NOT apply bank-account transfer-keyword detection', () => {
    const result = normalizeTransactions([raw('CREDIT CARD PAYMENT', -300)], format)
    expect(result[0].transactionType).toBe('debit')
  })

  it('still applies the SKIP filter', () => {
    const result = normalizeTransactions([raw('Opening Balance', 0), raw('Coffee', -5)], format)
    expect(result).toHaveLength(1)
  })
})

describe('normalizeTransactions — general behaviour', () => {
  it('preserves row order and other fields (date, category) unrelated to sign/type', () => {
    const rows = [raw('Groceries', -50), raw('Salary', 2000)]
    rows[0].category = 'Food'
    rows[1].category = 'Income'
    const result = normalizeTransactions(rows, { type: 'bank-account' })
    expect(result.map((r) => r.date)).toEqual(['2024-01-01', '2024-01-01'])
    expect(result.map((r) => r.category)).toEqual(['Food', 'Income'])
  })

  it('an empty input array yields an empty output array', () => {
    expect(normalizeTransactions([], { type: 'credit-card' })).toEqual([])
  })

  it('SKIP matching is case-insensitive and matches with flexible whitespace', () => {
    const result = normalizeTransactions(
      [raw('OPENING   BALANCE', 0), raw('end OF   statement', 0), raw('Coffee', -5)],
      { type: 'bank-account' },
    )
    expect(result).toHaveLength(1)
    expect(result[0].description).toBe('Coffee')
  })
})
