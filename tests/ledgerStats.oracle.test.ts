import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import {
  buildStatsSql,
  buildPendingSql,
  parseLedgerQuery,
  resolveCurrencyScope,
  toNumber,
  type LedgerQuery,
} from '@/lib/transactions-query'

// ─────────────────────────────────────────────────────────────────────────────
// Oracle: a verbatim port of the OLD in-memory filter + stats logic from
// LedgerView.tsx (the `filtered` memo + the `stats` memo). This is the
// behaviour the new SQL must reproduce. Kept here, in the test, so the app code
// can delete the client-side copy while this proves the SQL is equivalent.
//
// NOTE: the oracle intentionally does NOT apply the currency scope — the old
// code had the currency-mixing bug. Oracle-equivalence cases below use
// single-currency fixtures so the scope is a no-op; the currency fix is
// asserted separately.
// ─────────────────────────────────────────────────────────────────────────────

type Tx = {
  id: number
  date: string
  amount: number
  description: string
  originalDescription: string | null
  transactionType: string
  category: string
  accountId: number
  status: string
  reimbursableFor: string | null
  reimbursementTxId: number | null
  parentTransactionId: number | null
}

function oracleFiltered(txs: Tx[], q: LedgerQuery): Tx[] {
  return txs.filter((t) => {
    if (t.parentTransactionId !== null) return false
    if (q.pendingReimbursements && !(t.reimbursableFor && !t.reimbursementTxId)) return false
    if (q.accountId != null && t.accountId !== q.accountId) return false
    if (q.type && t.transactionType !== q.type) return false
    if (q.category && t.category !== q.category) return false
    if (q.status && t.status !== q.status) return false
    if (q.search) {
      const s = q.search.toLowerCase()
      if (
        !t.description.toLowerCase().includes(s) &&
        !(t.originalDescription ?? '').toLowerCase().includes(s)
      )
        return false
    }
    return true
  })
}

function oracleStats(txs: Tx[], q: LedgerQuery) {
  const filtered = oracleFiltered(txs, q)
  const settled = new Set<number>()
  for (const t of filtered) {
    if (t.reimbursementTxId != null) {
      settled.add(t.id)
      settled.add(t.reimbursementTxId)
    }
  }
  const nonTransfer = filtered.filter(
    (t) => t.transactionType !== 'transfer' && !settled.has(t.id),
  )
  const income = nonTransfer
    .filter((t) => t.transactionType === 'credit')
    .reduce((s, t) => s + Math.abs(t.amount), 0)
  const expenses = nonTransfer
    .filter((t) => t.transactionType === 'debit')
    .reduce((s, t) => s + Math.abs(t.amount), 0)
  return {
    income,
    expenses,
    net: income - expenses,
    incomeCount: nonTransfer.filter((t) => t.transactionType === 'credit').length,
    expenseCount: nonTransfer.filter((t) => t.transactionType === 'debit').length,
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Accounts 1 & 2 are USD; account 3 is EUR (for the currency-scope cases).
const ACCOUNTS = [
  { id: 1, currency: 'USD' },
  { id: 2, currency: 'USD' },
  { id: 3, currency: 'EUR' },
]

const FIXTURES: Tx[] = [
  { id: 1, date: '2026-01-05', amount: -1000, description: 'Coffee', originalDescription: null, transactionType: 'debit', category: 'Food', accountId: 1, status: 'committed', reimbursableFor: null, reimbursementTxId: null, parentTransactionId: null },
  { id: 2, date: '2026-01-06', amount: 5000, description: 'Salary', originalDescription: null, transactionType: 'credit', category: 'Income', accountId: 1, status: 'committed', reimbursableFor: null, reimbursementTxId: null, parentTransactionId: null },
  { id: 3, date: '2026-01-07', amount: -2000, description: 'Groceries', originalDescription: 'TESCO STORES', transactionType: 'debit', category: 'Food', accountId: 2, status: 'committed', reimbursableFor: null, reimbursementTxId: null, parentTransactionId: null },
  // transfer pair
  { id: 4, date: '2026-01-08', amount: -3000, description: 'Move out', originalDescription: null, transactionType: 'transfer', category: '', accountId: 1, status: 'committed', reimbursableFor: null, reimbursementTxId: null, parentTransactionId: null },
  { id: 5, date: '2026-01-08', amount: 3000, description: 'Move in', originalDescription: null, transactionType: 'transfer', category: '', accountId: 2, status: 'committed', reimbursableFor: null, reimbursementTxId: null, parentTransactionId: null },
  // split parent + legs
  { id: 6, date: '2026-01-09', amount: -6000, description: 'Amazon order', originalDescription: null, transactionType: 'debit', category: 'Shopping', accountId: 1, status: 'committed', reimbursableFor: null, reimbursementTxId: null, parentTransactionId: null },
  { id: 7, date: '2026-01-09', amount: -4000, description: 'Books', originalDescription: null, transactionType: 'debit', category: 'Books', accountId: 1, status: 'committed', reimbursableFor: null, reimbursementTxId: null, parentTransactionId: 6 },
  { id: 8, date: '2026-01-09', amount: -2000, description: 'Electronics', originalDescription: null, transactionType: 'debit', category: 'Electronics', accountId: 1, status: 'committed', reimbursableFor: null, reimbursementTxId: null, parentTransactionId: 6 },
  // matched reimbursement pair (expense 9 settled by credit 10)
  { id: 9, date: '2026-01-10', amount: -1500, description: 'Doctor', originalDescription: null, transactionType: 'debit', category: 'Health', accountId: 1, status: 'committed', reimbursableFor: 'Insurance', reimbursementTxId: 10, parentTransactionId: null },
  { id: 10, date: '2026-01-12', amount: 1500, description: 'Insurance payout', originalDescription: null, transactionType: 'credit', category: 'Reimbursement', accountId: 2, status: 'committed', reimbursableFor: null, reimbursementTxId: null, parentTransactionId: null },
  // pending reimbursement (unsettled)
  { id: 11, date: '2026-01-13', amount: -800, description: 'Pharmacy', originalDescription: null, transactionType: 'debit', category: 'Health', accountId: 1, status: 'committed', reimbursableFor: 'Insurance', reimbursementTxId: null, parentTransactionId: null },
  // review-status row
  { id: 12, date: '2026-01-14', amount: -500, description: 'Pending purchase', originalDescription: null, transactionType: 'debit', category: 'Food', accountId: 1, status: 'review', reimbursableFor: null, reimbursementTxId: null, parentTransactionId: null },
  // EUR account rows (only relevant to currency-scope cases)
  { id: 13, date: '2026-01-15', amount: -700, description: 'Paris lunch', originalDescription: null, transactionType: 'debit', category: 'Food', accountId: 3, status: 'committed', reimbursableFor: null, reimbursementTxId: null, parentTransactionId: null },
  { id: 14, date: '2026-01-16', amount: 9000, description: 'EUR income', originalDescription: null, transactionType: 'credit', category: 'Income', accountId: 3, status: 'committed', reimbursableFor: null, reimbursementTxId: null, parentTransactionId: null },
]

let db: Database.Database

beforeAll(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE "Transaction" (
      "id" INTEGER PRIMARY KEY,
      "date" TEXT NOT NULL,
      "amount" INTEGER NOT NULL,
      "description" TEXT NOT NULL,
      "originalDescription" TEXT,
      "transactionType" TEXT NOT NULL,
      "category" TEXT NOT NULL,
      "accountId" INTEGER NOT NULL,
      "status" TEXT NOT NULL,
      "reimbursableFor" TEXT,
      "reimbursementTxId" INTEGER,
      "parentTransactionId" INTEGER
    );
  `)
  const insert = db.prepare(`
    INSERT INTO "Transaction"
      ("id","date","amount","description","originalDescription","transactionType","category","accountId","status","reimbursableFor","reimbursementTxId","parentTransactionId")
    VALUES (@id,@date,@amount,@description,@originalDescription,@transactionType,@category,@accountId,@status,@reimbursableFor,@reimbursementTxId,@parentTransactionId)
  `)
  const tx = db.transaction((rows: Tx[]) => rows.forEach((r) => insert.run(r)))
  tx(FIXTURES)
})

afterAll(() => db.close())

function sqlStats(q: LedgerQuery, base: string) {
  const scope = resolveCurrencyScope(ACCOUNTS, q.accountId, base)
  const { sql, params } = buildStatsSql(q, scope)
  const row = db.prepare(sql).get(...(params as never[])) as Record<string, unknown>
  return {
    income: toNumber(row.income),
    expenses: toNumber(row.expenses),
    net: toNumber(row.income) - toNumber(row.expenses),
    incomeCount: toNumber(row.incomeCount),
    expenseCount: toNumber(row.expenseCount),
  }
}

function q(overrides: Partial<LedgerQuery> = {}): LedgerQuery {
  return {
    ...parseLedgerQuery(new URLSearchParams()),
    ...overrides,
  }
}

describe('ledger stats SQL matches the in-memory oracle (single-currency)', () => {
  // Restrict the oracle to USD rows so it and the currency-scoped SQL agree.
  const usdTxs = FIXTURES.filter((t) => t.accountId === 1 || t.accountId === 2)

  const cases: Array<[string, LedgerQuery]> = [
    ['no filters', q()],
    ['type=debit', q({ type: 'debit' })],
    ['type=credit', q({ type: 'credit' })],
    ['type=transfer', q({ type: 'transfer' })],
    ['category=Food', q({ category: 'Food' })],
    ['category=Health', q({ category: 'Health' })],
    ['status=committed', q({ status: 'committed' })],
    ['status=review', q({ status: 'review' })],
    ['accountId=1', q({ accountId: 1 })],
    ['accountId=2', q({ accountId: 2 })],
    ['search=tesco', q({ search: 'tesco' })],
    ['search=insurance', q({ search: 'insurance' })],
    ['pendingReimbursements', q({ pendingReimbursements: true })],
  ]

  for (const [name, query] of cases) {
    it(name, () => {
      // base=USD, and only account 1/2 exist for the oracle → currency scope
      // is a no-op, so SQL and oracle describe the same set.
      expect(sqlStats(query, 'USD')).toEqual(oracleStats(usdTxs, query))
    })
  }
})

describe('currency-mixing fix', () => {
  it('scopes "all accounts" stats to the base-currency accounts', () => {
    // With base=USD and a mix of USD + EUR accounts, the stats must NOT include
    // the EUR rows (13/14). Old behaviour summed them in and mislabelled.
    const usdOnly = oracleStats(
      FIXTURES.filter((t) => t.accountId === 1 || t.accountId === 2),
      q(),
    )
    expect(sqlStats(q(), 'USD')).toEqual(usdOnly)
  })

  it('a specific EUR account scopes to that account', () => {
    const eurOnly = oracleStats(FIXTURES.filter((t) => t.accountId === 3), q({ accountId: 3 }))
    expect(sqlStats(q({ accountId: 3 }), 'USD')).toEqual(eurOnly)
    // Sanity: EUR income row present.
    expect(sqlStats(q({ accountId: 3 }), 'USD').income).toBe(9000)
  })

  it('base=EUR scopes "all" to the EUR account', () => {
    const eurOnly = oracleStats(FIXTURES.filter((t) => t.accountId === 3), q())
    expect(sqlStats(q(), 'EUR')).toEqual(eurOnly)
  })
})

describe('pending reimbursements summary', () => {
  it('counts unsettled reimbursable rows in the currency scope', () => {
    const scope = resolveCurrencyScope(ACCOUNTS, null, 'USD')
    const { sql, params } = buildPendingSql(scope, null)
    const row = db.prepare(sql).get(...(params as never[])) as Record<string, unknown>
    // Only row 11 is pending in USD (row 9 is matched/settled).
    expect(toNumber(row.count)).toBe(1)
    expect(toNumber(row.outstanding)).toBe(800)
  })
})
