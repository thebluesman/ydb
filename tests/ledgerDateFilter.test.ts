import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import {
  buildPageIdsSql,
  parseLedgerQuery,
  resolveCurrencyScope,
  toDbDate,
  type LedgerQuery,
} from '@/lib/transactions-query'

// Phase U5: the ledger filter bar gained a startDate/endDate range control.
// Rows are stored with full ISO datetime strings (see toDbDate) — this fixture
// mirrors that (unlike tests/ledgerRows.oracle.test.ts, which uses bare
// YYYY-MM-DD strings and predates the date filter) so the inclusive-bound
// string comparison in buildFilterSql is exercised the way production data is
// actually shaped.

const ACCOUNTS = [{ id: 1, currency: 'USD' }]

type Row = { id: number; date: string }
const FIXTURES: Row[] = [
  { id: 1, date: toDbDate(new Date('2026-01-31T23:00:00.000Z')) }, // just before Feb 1 UTC
  { id: 2, date: toDbDate(new Date('2026-02-01T00:00:00.000Z')) }, // exactly Feb 1
  { id: 3, date: toDbDate(new Date('2026-02-15T12:00:00.000Z')) },
  { id: 4, date: toDbDate(new Date('2026-02-28T23:59:59.000Z')) }, // just before end of Feb 28 boundary
  { id: 5, date: toDbDate(new Date('2026-03-01T00:00:00.000Z')) }, // just after the range
]

let db: Database.Database

beforeAll(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE "Transaction" (
      "id" INTEGER PRIMARY KEY,
      "date" TEXT NOT NULL,
      "amount" INTEGER NOT NULL DEFAULT 0,
      "description" TEXT NOT NULL DEFAULT '',
      "originalDescription" TEXT,
      "transactionType" TEXT NOT NULL DEFAULT 'debit',
      "category" TEXT NOT NULL DEFAULT '',
      "accountId" INTEGER NOT NULL DEFAULT 1,
      "status" TEXT NOT NULL DEFAULT 'committed',
      "reimbursableFor" TEXT,
      "reimbursementTxId" INTEGER,
      "parentTransactionId" INTEGER
    );
  `)
  const insert = db.prepare(`INSERT INTO "Transaction" ("id","date") VALUES (@id,@date)`)
  const tx = db.transaction((rows: Row[]) => rows.forEach((r) => insert.run(r)))
  tx(FIXTURES)
})

afterAll(() => db.close())

function q(overrides: Partial<LedgerQuery> = {}): LedgerQuery {
  return { ...parseLedgerQuery(new URLSearchParams()), pageSize: 500, ...overrides }
}

function pageIds(query: LedgerQuery): number[] {
  const scope = resolveCurrencyScope(ACCOUNTS, query.accountId, 'USD')
  const { sql, params } = buildPageIdsSql(query, scope)
  return (db.prepare(sql).all(...(params as never[])) as Array<{ id: number }>).map((r) => r.id)
}

describe('ledger date-range filter', () => {
  it('with no bounds, every row is returned', () => {
    expect(pageIds(q()).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
  })

  it('startDate is an inclusive lower bound on the UTC calendar day', () => {
    expect(pageIds(q({ startDate: '2026-02-01' })).sort((a, b) => a - b)).toEqual([2, 3, 4, 5])
  })

  it('endDate is an inclusive upper bound on the UTC calendar day', () => {
    expect(pageIds(q({ endDate: '2026-02-28' })).sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
  })

  it('startDate + endDate together select exactly February', () => {
    expect(pageIds(q({ startDate: '2026-02-01', endDate: '2026-02-28' })).sort((a, b) => a - b)).toEqual([
      2, 3, 4,
    ])
  })

  it('a malformed startDate is dropped by parseLedgerQuery rather than breaking the query', () => {
    const parsed = parseLedgerQuery(new URLSearchParams('startDate=not-a-date'))
    expect(parsed.startDate).toBeNull()
  })
})
