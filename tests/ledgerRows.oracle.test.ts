import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import {
  buildCountSql,
  buildExportIdsSql,
  buildPageIdsSql,
  buildStatsSql,
  parseLedgerQuery,
  resolveCurrencyScope,
  toNumber,
  type LedgerQuery,
} from '@/lib/transactions-query'

// ─────────────────────────────────────────────────────────────────────────────
// Coverage for the ROW list (not just the stats): the page/count/export id
// queries all share buildFilterSql, so they must select exactly the set the old
// in-memory `filtered` memo did — including LITERAL treatment of `%`/`_` in the
// search term (the row list used to run through Prisma `contains`, which treats
// those as wildcards; the stats escaped them, so the two could disagree).
//
// Also pins the multi-currency decision: on "All accounts" the row list spans
// EVERY account regardless of currency (NOT currency-scoped), while the stats
// stay scoped to the base currency.
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

// The old in-memory row filter (verbatim `.includes()` substring — literal).
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

const ACCOUNTS = [
  { id: 1, currency: 'USD' },
  { id: 2, currency: 'USD' },
  { id: 3, currency: 'EUR' },
]

const FIXTURES: Tx[] = [
  { id: 1, date: '2026-01-05', amount: -1000, description: 'Coffee', originalDescription: null, transactionType: 'debit', category: 'Food', accountId: 1, status: 'committed', reimbursableFor: null, reimbursementTxId: null, parentTransactionId: null },
  { id: 2, date: '2026-01-06', amount: 5000, description: 'Salary', originalDescription: null, transactionType: 'credit', category: 'Income', accountId: 1, status: 'committed', reimbursableFor: null, reimbursementTxId: null, parentTransactionId: null },
  { id: 3, date: '2026-01-07', amount: -2000, description: 'Groceries', originalDescription: 'TESCO STORES', transactionType: 'debit', category: 'Food', accountId: 2, status: 'committed', reimbursableFor: null, reimbursementTxId: null, parentTransactionId: null },
  // split leg — must never appear in the row list
  { id: 4, date: '2026-01-08', amount: -4000, description: 'Split parent', originalDescription: null, transactionType: 'debit', category: 'Shopping', accountId: 1, status: 'committed', reimbursableFor: null, reimbursementTxId: null, parentTransactionId: null },
  { id: 5, date: '2026-01-08', amount: -1500, description: 'Leg', originalDescription: null, transactionType: 'debit', category: 'Books', accountId: 1, status: 'committed', reimbursableFor: null, reimbursementTxId: 4, parentTransactionId: 4 },
  // literal wildcard characters in the description
  { id: 6, date: '2026-01-09', amount: -300, description: '50% cashback', originalDescription: null, transactionType: 'debit', category: 'Food', accountId: 1, status: 'committed', reimbursableFor: null, reimbursementTxId: null, parentTransactionId: null },
  { id: 7, date: '2026-01-09', amount: -500, description: '500 dollars', originalDescription: null, transactionType: 'debit', category: 'Food', accountId: 1, status: 'committed', reimbursableFor: null, reimbursementTxId: null, parentTransactionId: null },
  { id: 8, date: '2026-01-10', amount: -200, description: 'a_b snack', originalDescription: null, transactionType: 'debit', category: 'Food', accountId: 2, status: 'committed', reimbursableFor: null, reimbursementTxId: null, parentTransactionId: null },
  { id: 9, date: '2026-01-10', amount: -250, description: 'axb snack', originalDescription: null, transactionType: 'debit', category: 'Food', accountId: 2, status: 'committed', reimbursableFor: null, reimbursementTxId: null, parentTransactionId: null },
  // EUR rows (base=USD → excluded from stats, but present in the row list)
  { id: 10, date: '2026-01-15', amount: -700, description: 'Paris lunch', originalDescription: null, transactionType: 'debit', category: 'Food', accountId: 3, status: 'committed', reimbursableFor: null, reimbursementTxId: null, parentTransactionId: null },
  { id: 11, date: '2026-01-16', amount: 9000, description: 'EUR income', originalDescription: null, transactionType: 'credit', category: 'Income', accountId: 3, status: 'committed', reimbursableFor: null, reimbursementTxId: null, parentTransactionId: null },
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

function q(overrides: Partial<LedgerQuery> = {}): LedgerQuery {
  return { ...parseLedgerQuery(new URLSearchParams()), pageSize: 500, ...overrides }
}

function pageIds(query: LedgerQuery, base = 'USD'): number[] {
  const scope = resolveCurrencyScope(ACCOUNTS, query.accountId, base)
  const { sql, params } = buildPageIdsSql(query, scope)
  return (db.prepare(sql).all(...(params as never[])) as Array<{ id: number }>).map((r) => r.id)
}

describe('ledger row selection matches the in-memory oracle (literal search)', () => {
  const cases: Array<[string, LedgerQuery]> = [
    ['no filters', q()],
    ['type=debit', q({ type: 'debit' })],
    ['category=Food', q({ category: 'Food' })],
    ['search=snack', q({ search: 'snack' })],
    ['search=tesco (matches originalDescription)', q({ search: 'tesco' })],
    // literal wildcard cases — the whole point of the escaping fix
    ['search=50% is literal (not a wildcard)', q({ search: '50%' })],
    ['search=a_b is literal (underscore not a wildcard)', q({ search: 'a_b' })],
  ]

  for (const [name, query] of cases) {
    it(name, () => {
      // Oracle uses ALL accounts (row list is not currency-scoped).
      const expected = oracleFiltered(FIXTURES, query).map((t) => t.id).sort((a, b) => a - b)
      expect([...pageIds(query)].sort((a, b) => a - b)).toEqual(expected)
    })
  }

  it('50% matches the literal-percent row but not "500 dollars"', () => {
    expect(pageIds(q({ search: '50%' }))).toEqual([6])
  })

  it('a_b matches the literal-underscore row but not "axb snack"', () => {
    expect(pageIds(q({ search: 'a_b' }))).toEqual([8])
  })

  it('split legs (parentTransactionId set) never appear', () => {
    expect(pageIds(q())).not.toContain(5)
  })
})

describe('count agrees with the row list', () => {
  it('buildCountSql equals the number of selected rows', () => {
    const query = q({ category: 'Food' })
    const scope = resolveCurrencyScope(ACCOUNTS, query.accountId, 'USD')
    const { sql, params } = buildCountSql(query, scope)
    const row = db.prepare(sql).get(...(params as never[])) as Record<string, unknown>
    expect(toNumber(row.count)).toBe(pageIds(query).length)
  })
})

describe('CSV export selects the full filtered set in the same way', () => {
  it('buildExportIdsSql returns the same set as the page (no pagination limit)', () => {
    const query = q({ type: 'debit' })
    const scope = resolveCurrencyScope(ACCOUNTS, query.accountId, 'USD')
    const { sql, params } = buildExportIdsSql(query, scope)
    const exportIds = (db.prepare(sql).all(...(params as never[])) as Array<{ id: number }>)
      .map((r) => r.id)
      .sort((a, b) => a - b)
    expect(exportIds).toEqual([...pageIds(query)].sort((a, b) => a - b))
  })
})

describe('multi-currency "All accounts" — rows span all currencies, stats do not', () => {
  it('the row list INCLUDES the EUR rows (not currency-scoped)', () => {
    const ids = pageIds(q(), 'USD')
    expect(ids).toContain(10) // Paris lunch (EUR)
    expect(ids).toContain(11) // EUR income (EUR)
  })

  it('the stats EXCLUDE the EUR rows (scoped to the base currency)', () => {
    const scope = resolveCurrencyScope(ACCOUNTS, null, 'USD')
    const { sql, params } = buildStatsSql(q(), scope)
    const row = db.prepare(sql).get(...(params as never[])) as Record<string, unknown>
    // EUR income row (9000) must NOT be summed into USD income.
    expect(toNumber(row.income)).toBe(5000) // only the USD Salary row
  })
})
