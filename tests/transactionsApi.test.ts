import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end test of GET /api/transactions (IMPROVEMENT_PLAN Phase 8) against
// a fixture DB. The query-builder functions in lib/transactions-query.ts
// already have thorough oracle coverage (tests/ledgerRows.oracle.test.ts,
// tests/ledgerStats.oracle.test.ts); this file instead drives the actual
// route handler — parsing querystring params, running the real SQL through a
// real (in-memory) SQLite connection, and hydrating relations — the same
// pattern tests/transactionDeleteCascade.test.ts uses to mock '@/lib/prisma'
// with an in-memory fake, but backed by a real SQL database rather than a
// JS Map so the actual filter/sort/pagination/stats SQL text executes.
// ─────────────────────────────────────────────────────────────────────────────

let db: Database.Database

vi.mock('@/lib/prisma', () => {
  return {
    prisma: {
      $queryRawUnsafe: async (sql: string, ...params: unknown[]) => db.prepare(sql).all(...params),
      account: {
        findMany: async ({ where }: { where?: { isActive?: boolean } } = {}) => {
          const rows = db.prepare('SELECT id, currency, isActive FROM "Account"').all() as Array<{
            id: number; currency: string; isActive: number
          }>
          return rows
            .filter((r) => (where?.isActive == null ? true : Boolean(r.isActive) === where.isActive))
            .map((r) => ({ id: r.id, currency: r.currency }))
        },
      },
      setting: {
        findFirst: async ({ where: { key } }: { where: { key: string } }) => {
          const row = db.prepare('SELECT value FROM "Setting" WHERE key = ?').get(key) as
            | { value: string }
            | undefined
          return row ? { value: row.value } : null
        },
      },
      transaction: {
        findMany: async ({
          where,
          include,
          select,
        }: {
          where: { id: { in: number[] } }
          include?: Record<string, unknown>
          select?: Record<string, unknown>
        }) => {
          const ids = where.id.in
          if (ids.length === 0) return []
          const placeholders = ids.map(() => '?').join(',')
          const rows = db
            .prepare(`SELECT * FROM "Transaction" WHERE id IN (${placeholders})`)
            .all(...ids) as Array<Record<string, unknown>>
          return rows.map((row) => hydrate(row, include ?? select ?? {}, Boolean(select)))
        },
      },
    },
  }
})

function hydrate(row: Record<string, unknown>, relSpec: Record<string, unknown>, selectMode: boolean) {
  const out: Record<string, unknown> = selectMode ? {} : { ...row }
  if (selectMode) {
    for (const key of Object.keys(relSpec)) {
      if (key === 'account' || key === 'splitLegs' || key === 'reimbursementTx' || key === 'reimbursedExpense' || key === 'transferCounterpartAccount') continue
      out[key] = row[key]
    }
  }
  const accountId = row.accountId as number
  if ('account' in relSpec) {
    const acc = db.prepare('SELECT name, currency FROM "Account" WHERE id = ?').get(accountId) as
      | { name: string; currency: string }
      | undefined
    out.account = acc ?? null
  }
  if ('splitLegs' in relSpec) {
    out.splitLegs = db
      .prepare('SELECT id, amount, category, description FROM "Transaction" WHERE parentTransactionId = ?')
      .all(row.id)
  }
  if ('reimbursementTx' in relSpec && row.reimbursementTxId != null) {
    out.reimbursementTx = db
      .prepare('SELECT id, amount, description FROM "Transaction" WHERE id = ?')
      .get(row.reimbursementTxId)
  } else if ('reimbursementTx' in relSpec) {
    out.reimbursementTx = null
  }
  if ('reimbursedExpense' in relSpec) {
    out.reimbursedExpense =
      db.prepare('SELECT id, description FROM "Transaction" WHERE reimbursementTxId = ?').get(row.id) ?? null
  }
  if ('transferCounterpartAccount' in relSpec && row.transferCounterpartAccountId != null) {
    out.transferCounterpartAccount = db
      .prepare('SELECT id, name FROM "Account" WHERE id = ?')
      .get(row.transferCounterpartAccountId)
  } else if ('transferCounterpartAccount' in relSpec) {
    out.transferCounterpartAccount = null
  }
  return out
}

beforeAll(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE "Account" (
      "id" INTEGER PRIMARY KEY,
      "name" TEXT NOT NULL,
      "currency" TEXT NOT NULL,
      "isActive" INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE "Setting" (
      "id" INTEGER PRIMARY KEY,
      "key" TEXT UNIQUE NOT NULL,
      "value" TEXT NOT NULL
    );
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
      "notes" TEXT,
      "reimbursableFor" TEXT,
      "reimbursementTxId" INTEGER,
      "parentTransactionId" INTEGER
    );
  `)
  db.exec(`
    INSERT INTO "Account" (id, name, currency, isActive) VALUES
      (1, 'Current', 'USD', 1),
      (2, 'Credit Card', 'USD', 1);
    INSERT INTO "Setting" (id, key, value) VALUES (1, 'baseCurrency', 'USD');
  `)
  const insert = db.prepare(`
    INSERT INTO "Transaction"
      (id, date, amount, description, originalDescription, transactionType, category, accountId, status, notes, reimbursableFor, reimbursementTxId, parentTransactionId)
    VALUES (@id, @date, @amount, @description, @originalDescription, @transactionType, @category, @accountId, @status, @notes, @reimbursableFor, @reimbursementTxId, @parentTransactionId)
  `)
  const rows = [
    { id: 1, date: '2026-01-05T00:00:00.000+00:00', amount: -1000, description: 'Coffee', originalDescription: null, transactionType: 'debit', category: 'Food', accountId: 1, status: 'committed', notes: null, reimbursableFor: null, reimbursementTxId: null, parentTransactionId: null },
    { id: 2, date: '2026-01-06T00:00:00.000+00:00', amount: 500000, description: 'Salary', originalDescription: null, transactionType: 'credit', category: 'Income', accountId: 1, status: 'committed', notes: null, reimbursableFor: null, reimbursementTxId: null, parentTransactionId: null },
    { id: 3, date: '2026-01-07T00:00:00.000+00:00', amount: -2000, description: 'Groceries', originalDescription: 'TESCO STORES', transactionType: 'debit', category: 'Food', accountId: 2, status: 'committed', notes: null, reimbursableFor: null, reimbursementTxId: null, parentTransactionId: null },
    { id: 4, date: '2026-01-08T00:00:00.000+00:00', amount: -4000, description: 'Split parent', originalDescription: null, transactionType: 'debit', category: 'Shopping', accountId: 1, status: 'committed', notes: null, reimbursableFor: null, reimbursementTxId: null, parentTransactionId: null },
    { id: 5, date: '2026-01-08T00:00:00.000+00:00', amount: -1500, description: 'Leg', originalDescription: null, transactionType: 'debit', category: 'Books', accountId: 1, status: 'committed', notes: null, reimbursableFor: null, reimbursementTxId: null, parentTransactionId: 4 },
    { id: 6, date: '2026-01-09T00:00:00.000+00:00', amount: -300, description: 'Taxi fare', originalDescription: null, transactionType: 'debit', category: 'Transport', accountId: 1, status: 'review', notes: null, reimbursableFor: 'Employer', reimbursementTxId: null, parentTransactionId: null },
    { id: 7, date: '2026-01-10T00:00:00.000+00:00', amount: -800, description: 'Dinner with client', originalDescription: null, transactionType: 'debit', category: 'Dining', accountId: 1, status: 'committed', notes: null, reimbursableFor: 'Employer', reimbursementTxId: 8, parentTransactionId: null },
    { id: 8, date: '2026-01-12T00:00:00.000+00:00', amount: 800, description: 'Expense reimbursement', originalDescription: null, transactionType: 'credit', category: 'Reimbursement', accountId: 1, status: 'committed', notes: null, reimbursableFor: null, reimbursementTxId: null, parentTransactionId: null },
  ]
  const tx = db.transaction((rs: typeof rows) => rs.forEach((r) => insert.run(r)))
  tx(rows)
})

afterAll(() => db.close())

import { GET } from '@/app/api/transactions/route'

function makeRequest(query: string): Request {
  return new Request(`http://localhost/api/transactions${query}`)
}

describe('GET /api/transactions', () => {
  it('returns all top-level (non-split-leg) rows with default pagination', async () => {
    const res = await GET(makeRequest(''))
    const body = await res.json()
    // 8 rows total, minus 1 split leg (id 5) = 7.
    expect(body.total).toBe(7)
    expect(body.rows).toHaveLength(7)
    expect(body.rows.map((r: { id: number }) => r.id)).not.toContain(5)
  })

  it('filters by accountId', async () => {
    const res = await GET(makeRequest('?accountId=2'))
    const body = await res.json()
    expect(body.total).toBe(1)
    expect(body.rows[0].id).toBe(3)
  })

  it('filters by type', async () => {
    const res = await GET(makeRequest('?type=credit'))
    const body = await res.json()
    expect(body.rows.map((r: { id: number }) => r.id).sort()).toEqual([2, 8])
  })

  it('filters by category', async () => {
    const res = await GET(makeRequest('?category=Food'))
    const body = await res.json()
    expect(body.rows.map((r: { id: number }) => r.id).sort()).toEqual([1, 3])
  })

  it('filters by status', async () => {
    const res = await GET(makeRequest('?status=review'))
    const body = await res.json()
    expect(body.rows.map((r: { id: number }) => r.id)).toEqual([6])
  })

  it('search matches description OR originalDescription', async () => {
    const res = await GET(makeRequest('?search=tesco'))
    const body = await res.json()
    expect(body.rows.map((r: { id: number }) => r.id)).toEqual([3])
  })

  it('pendingReimbursements=1 returns only rows with reimbursableFor set and unmatched', async () => {
    const res = await GET(makeRequest('?pendingReimbursements=1'))
    const body = await res.json()
    expect(body.rows.map((r: { id: number }) => r.id)).toEqual([6])
    // id 7 is excluded: it has a reimbursementTxId already (matched).
  })

  it('sorts by amount ascending', async () => {
    const res = await GET(makeRequest('?sort=amount&dir=asc'))
    const body = await res.json()
    const amounts = body.rows.map((r: { amount: number }) => r.amount)
    expect(amounts).toEqual([...amounts].sort((a, b) => a - b))
  })

  it('paginates: pageSize=2 page=2 returns the second slice in date-desc default order', async () => {
    const all = await (await GET(makeRequest('?pageSize=50'))).json()
    const allIdsInDefaultOrder = all.rows.map((r: { id: number }) => r.id)

    const res = await GET(makeRequest('?pageSize=2&page=2'))
    const body = await res.json()
    expect(body.rows).toHaveLength(2)
    expect(body.rows.map((r: { id: number }) => r.id)).toEqual(allIdsInDefaultOrder.slice(2, 4))
  })

  it('stats exclude transfers and both sides of a matched reimbursement pair', async () => {
    const res = await GET(makeRequest(''))
    const body = await res.json()
    // Income: Salary (500000) only — the matched reimbursement settlement
    // (id 8, credit 800) must be excluded because it settles id 7.
    expect(body.stats.income).toBe(500000)
    // Expenses: Coffee(1000) + Groceries(2000) + Split parent(4000) +
    // Taxi(300) = 7300. Dinner-with-client (id 7, 800) is excluded — it's
    // the matched/settled expense side.
    expect(body.stats.expenses).toBe(1000 + 2000 + 4000 + 300)
  })

  it('pendingReimbursementCount / outstanding reflect only the unmatched row', async () => {
    const res = await GET(makeRequest(''))
    const body = await res.json()
    expect(body.stats.pendingReimbursementCount).toBe(1)
    expect(body.stats.pendingReimbursementOutstanding).toBe(300)
  })

  it('hydrated rows include the expected relations (account, splitLegs)', async () => {
    const res = await GET(makeRequest('?category=Shopping'))
    const body = await res.json()
    const parent = body.rows[0]
    expect(parent.account.name).toBe('Current')
    expect(parent.splitLegs).toHaveLength(1)
    expect(parent.splitLegs[0].id).toBe(5)
  })

  it('CSV export streams the full filtered set with the right content type', async () => {
    const res = await GET(makeRequest('?format=csv&category=Food'))
    expect(res.headers.get('Content-Type')).toContain('text/csv')
    const text = await res.text()
    const lines = text.trim().split('\n')
    // header + 2 Food rows
    expect(lines).toHaveLength(3)
    expect(text).toContain('Coffee')
    expect(text).toContain('Groceries')
  })
})
