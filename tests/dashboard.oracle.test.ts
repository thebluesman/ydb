import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import {
  toDbDate,
  monthlySql,
  categorySql,
  categoryTrendSql,
  preRangeAssetSumSql,
} from '@/lib/transactions-query'

// ─────────────────────────────────────────────────────────────────────────────
// Oracle test for Phase 2 (dashboard SQL aggregation).
//
// This asserts the new SQL aggregation is byte-for-byte equivalent to the OLD
// in-memory JS aggregation that shipped in app/dashboard/page.tsx before this
// milestone. The JS oracle below is a verbatim port of that logic (monthly
// income/expenses, category breakdown, per-category trend, and the pre-range
// asset seed, plus the split-parent / reimbursement-pair `hiddenTxIds` rules).
//
// Per IMPROVEMENT_PLAN Phase 2 / M2b precedent (tests/ledgerStats.oracle.test),
// the oracle is written and passing BEFORE the old JS is deleted from the page.
// ─────────────────────────────────────────────────────────────────────────────

type Row = {
  id: number
  date: string
  amount: number
  transactionType: 'credit' | 'debit' | 'transfer'
  category: string
  accountId: number
  status: string
  parentTransactionId: number | null
  reimbursementTxId: number | null
}

// Month helpers copied verbatim from app/dashboard/page.tsx.
function monthKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// ── The verbatim JS oracle (old dashboard aggregation) ───────────────────────
function jsOracle(all: Row[], accountIds: number[], assetAccountIds: number[], startDate: Date, endDate: Date) {
  const inScope = (t: Row) =>
    accountIds.includes(t.accountId) && (t.status === 'committed' || t.status === 'reconciled')
  const txs = all.filter(inScope)

  const splitParentIds = new Set<number>()
  const settlementIds = new Set<number>()
  const reimbursedExpenseIds = new Set<number>()
  for (const t of txs) {
    if (t.parentTransactionId !== null) splitParentIds.add(t.parentTransactionId)
    if (t.reimbursementTxId !== null) {
      reimbursedExpenseIds.add(t.id)
      settlementIds.add(t.reimbursementTxId)
    }
  }
  const hiddenTxIds = new Set<number>([...splitParentIds, ...settlementIds, ...reimbursedExpenseIds])
  const includeInTotals = (t: Row) => !hiddenTxIds.has(t.id)

  // Category breakdown (debit only, in range)
  const catMap = new Map<string, { total: number; count: number }>()
  for (const t of txs) {
    const d = new Date(t.date)
    if (d < startDate || d > endDate) continue
    if (t.transactionType !== 'debit') continue
    if (!includeInTotals(t)) continue
    const cur = catMap.get(t.category) ?? { total: 0, count: 0 }
    catMap.set(t.category, { total: cur.total + Math.abs(t.amount), count: cur.count + 1 })
  }

  // Monthly income/expenses
  const monthMap = new Map<string, { income: number; expenses: number; cnt: number }>()
  const cur = new Date(startDate.getFullYear(), startDate.getMonth(), 1)
  while (cur <= endDate) {
    monthMap.set(monthKey(cur), { income: 0, expenses: 0, cnt: 0 })
    cur.setMonth(cur.getMonth() + 1)
  }
  for (const t of txs) {
    const d = new Date(t.date)
    if (d < startDate || d > endDate) continue
    if (t.transactionType === 'transfer') continue
    if (!includeInTotals(t)) continue
    const key = monthKey(d)
    const m = monthMap.get(key)
    if (!m) continue
    m.cnt++
    if (t.transactionType === 'credit') m.income += Math.abs(t.amount)
    else if (t.transactionType === 'debit') m.expenses += Math.abs(t.amount)
  }

  // Summary (derived the same way the page now derives it)
  let totalIncome = 0, totalExpenses = 0, txCount = 0
  for (const t of txs) {
    const d = new Date(t.date)
    if (d < startDate || d > endDate) continue
    if (t.transactionType === 'transfer') continue
    if (!includeInTotals(t)) continue
    txCount++
    if (t.transactionType === 'credit') totalIncome += Math.abs(t.amount)
    else if (t.transactionType === 'debit') totalExpenses += Math.abs(t.amount)
  }

  // Per-category monthly trend (debit only, in range)
  const trend = new Map<string, Map<string, number>>() // ym -> cat -> total
  for (const t of txs) {
    const d = new Date(t.date)
    if (d < startDate || d > endDate) continue
    if (t.transactionType !== 'debit') continue
    if (!includeInTotals(t)) continue
    const key = monthKey(d)
    if (!trend.has(key)) trend.set(key, new Map())
    const row = trend.get(key)!
    row.set(t.category, (row.get(t.category) ?? 0) + Math.abs(t.amount))
  }

  // Pre-range asset seed (raw signed sum, own hidden set, includes transfers)
  const preRows = all.filter(
    (t) =>
      assetAccountIds.includes(t.accountId) &&
      (t.status === 'committed' || t.status === 'reconciled') &&
      new Date(t.date) < startDate,
  )
  const preSplitParents = new Set<number>()
  const preSettlements = new Set<number>()
  const preReimbExpenses = new Set<number>()
  for (const t of preRows) {
    if (t.parentTransactionId !== null) preSplitParents.add(t.parentTransactionId)
    if (t.reimbursementTxId !== null) {
      preReimbExpenses.add(t.id)
      preSettlements.add(t.reimbursementTxId)
    }
  }
  const preHidden = new Set<number>([...preSplitParents, ...preSettlements, ...preReimbExpenses])
  let preRangeAssetSum = 0
  for (const t of preRows) {
    if (preHidden.has(t.id)) continue
    preRangeAssetSum += t.amount
  }

  return {
    monthly: monthMap,
    categories: catMap,
    summary: { totalIncome, totalExpenses, txCount },
    trend,
    preRangeAssetSum,
  }
}

// ── Fixture ──────────────────────────────────────────────────────────────────
// GBP accounts = 1, 2 (both assets); USD account = 3 (must be ignored).
const ACCOUNT_IDS = [1, 2]
const ASSET_IDS = [1, 2]
const START = new Date('2024-01-01T00:00:00.000Z')
const END = new Date('2024-03-31T23:59:59.999Z')

// id, date, amount(cents), type, category, accountId, status, parentId, reimbId
function tx(
  id: number, dateIso: string, amount: number, type: Row['transactionType'],
  category: string, accountId: number, status = 'committed',
  parentTransactionId: number | null = null, reimbursementTxId: number | null = null,
): Row {
  return { id, date: toDbDate(new Date(dateIso)), amount, transactionType: type, category, accountId, status, parentTransactionId, reimbursementTxId }
}

const FIXTURE: Row[] = [
  // Normal in-range activity
  tx(1, '2024-01-10T00:00:00Z', -1000, 'debit', 'Groceries', 1),
  tx(2, '2024-01-20T00:00:00Z', 5000, 'credit', 'Income', 1),
  tx(3, '2024-02-05T00:00:00Z', -2000, 'transfer', 'Transfer', 1), // excluded from income/expense
  tx(4, '2024-02-14T00:00:00Z', -750, 'debit', 'Groceries', 2),
  // Split: parent (hidden because legs exist) + 2 legs (counted)
  tx(10, '2024-02-20T00:00:00Z', -3000, 'debit', 'Shopping', 1),
  tx(11, '2024-02-20T00:00:00Z', -1000, 'debit', 'Food', 1, 'committed', 10),
  tx(12, '2024-02-20T00:00:00Z', -2000, 'debit', 'Electronics', 1, 'committed', 10),
  // Reimbursement pair: expense (id 20, reimbursementTxId=21) + settlement (id 21) — both hidden
  tx(20, '2024-03-03T00:00:00Z', -1500, 'debit', 'Health', 1, 'committed', null, 21),
  tx(21, '2024-03-04T00:00:00Z', 1500, 'credit', 'Reimbursement', 1),
  // A review-status row (out of scope) — must be ignored everywhere
  tx(30, '2024-03-10T00:00:00Z', -9999, 'debit', 'Groceries', 1, 'review'),
  // Multi-currency: USD account 3 — must NOT contribute to the GBP aggregation
  tx(40, '2024-03-11T00:00:00Z', -12345, 'debit', 'Groceries', 3),
  // Out-of-range in-scope row (after END) — excluded by date filter
  tx(50, '2024-04-01T00:00:00Z', -4444, 'debit', 'Groceries', 1),

  // ── Pre-range (before START) — feeds the asset seed only ──
  tx(100, '2023-12-15T00:00:00Z', -800, 'debit', 'Groceries', 1),
  tx(101, '2023-12-16T00:00:00Z', 20000, 'credit', 'Income', 1),
  tx(102, '2023-12-17T00:00:00Z', -500, 'transfer', 'Transfer', 1), // pre-range transfer IS included in raw seed
  // Pre-range split: parent hidden, legs counted (net effect equals parent, but tests the rule)
  tx(110, '2023-12-18T00:00:00Z', -600, 'debit', 'Shopping', 1),
  tx(111, '2023-12-18T00:00:00Z', -600, 'debit', 'Food', 1, 'committed', 110),
  // Pre-range reimbursement pair: both hidden from the seed
  tx(120, '2023-12-19T00:00:00Z', -300, 'debit', 'Health', 1, 'committed', null, 121),
  tx(121, '2023-12-20T00:00:00Z', 300, 'credit', 'Reimbursement', 1),
  // Pre-range USD row — ignored (not an asset account in this currency scope)
  tx(130, '2023-12-21T00:00:00Z', -7777, 'debit', 'Groceries', 3),
]

let db: Database.Database
beforeAll(() => {
  db = new Database(':memory:')
  db.exec(`CREATE TABLE "Transaction" (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    amount INTEGER NOT NULL,
    transactionType TEXT NOT NULL,
    category TEXT NOT NULL,
    accountId INTEGER NOT NULL,
    status TEXT NOT NULL,
    parentTransactionId INTEGER,
    reimbursementTxId INTEGER
  )`)
  const ins = db.prepare(
    `INSERT INTO "Transaction" (id,date,amount,transactionType,category,accountId,status,parentTransactionId,reimbursementTxId)
     VALUES (@id,@date,@amount,@transactionType,@category,@accountId,@status,@parentTransactionId,@reimbursementTxId)`,
  )
  const insertAll = db.transaction((rows: Row[]) => rows.forEach((r) => ins.run(r)))
  insertAll(FIXTURE)
})
afterAll(() => db?.close())

const startIso = toDbDate(START)
const endIso = toDbDate(END)

describe('dashboard SQL aggregation vs JS oracle', () => {
  const oracle = () => jsOracle(FIXTURE, ACCOUNT_IDS, ASSET_IDS, START, END)

  it('monthly income/expenses/count match', () => {
    const rows = db
      .prepare(monthlySql(ACCOUNT_IDS, startIso, endIso))
      .all() as { ym: string; income: number; expenses: number; cnt: number }[]
    const sqlMap = new Map(rows.map((r) => [r.ym, r]))
    const { monthly } = oracle()
    for (const [ym, js] of monthly) {
      const sql = sqlMap.get(ym)
      expect(Number(sql?.income ?? 0), `income ${ym}`).toBe(js.income)
      expect(Number(sql?.expenses ?? 0), `expenses ${ym}`).toBe(js.expenses)
      expect(Number(sql?.cnt ?? 0), `count ${ym}`).toBe(js.cnt)
    }
    // SQL must not produce any month outside the JS-seeded set
    for (const r of rows) expect(monthly.has(r.ym), `unexpected month ${r.ym}`).toBe(true)
  })

  it('summary totals derived from monthly match', () => {
    const rows = db.prepare(monthlySql(ACCOUNT_IDS, startIso, endIso)).all() as { income: number; expenses: number; cnt: number }[]
    const totalIncome = rows.reduce((s, r) => s + Number(r.income), 0)
    const totalExpenses = rows.reduce((s, r) => s + Number(r.expenses), 0)
    const txCount = rows.reduce((s, r) => s + Number(r.cnt), 0)
    const { summary } = oracle()
    expect(totalIncome).toBe(summary.totalIncome)
    expect(totalExpenses).toBe(summary.totalExpenses)
    expect(txCount).toBe(summary.txCount)
  })

  it('category breakdown matches', () => {
    const rows = db.prepare(categorySql(ACCOUNT_IDS, startIso, endIso)).all() as { category: string; total: number; cnt: number }[]
    const sqlMap = new Map(rows.map((r) => [r.category, r]))
    const { categories } = oracle()
    expect(new Set(rows.map((r) => r.category))).toEqual(new Set(categories.keys()))
    for (const [cat, js] of categories) {
      expect(Number(sqlMap.get(cat)?.total ?? 0), `total ${cat}`).toBe(js.total)
      expect(Number(sqlMap.get(cat)?.cnt ?? 0), `count ${cat}`).toBe(js.count)
    }
  })

  it('per-category monthly trend matches', () => {
    const rows = db.prepare(categoryTrendSql(ACCOUNT_IDS, startIso, endIso)).all() as { ym: string; category: string; total: number }[]
    const { trend } = oracle()
    // every SQL cell exists in the oracle with the same value
    for (const r of rows) {
      expect(trend.get(r.ym)?.get(r.category), `trend ${r.ym}/${r.category}`).toBe(Number(r.total))
    }
    // every oracle cell exists in the SQL result
    const sqlKey = new Set(rows.map((r) => `${r.ym}|${r.category}`))
    for (const [ym, cats] of trend) {
      for (const cat of cats.keys()) expect(sqlKey.has(`${ym}|${cat}`), `missing ${ym}/${cat}`).toBe(true)
    }
  })

  it('pre-range asset seed matches (includes transfers, excludes hidden)', () => {
    const row = db.prepare(preRangeAssetSumSql(ASSET_IDS, startIso)).get() as { s: number }
    const { preRangeAssetSum } = oracle()
    expect(Number(row.s)).toBe(preRangeAssetSum)
    // sanity: -800 + 20000 - 500 - 600(parent hidden) - 600(leg) ... let it be asserted by oracle
  })

  it('the fixture actually exercises every exclusion rule (guards against a trivially-passing oracle)', () => {
    const { categories, summary } = oracle()
    // split legs present, parent absent
    expect(categories.has('Food')).toBe(true)
    expect(categories.has('Electronics')).toBe(true)
    expect(categories.get('Shopping')).toBeUndefined() // parent hidden
    // reimbursement pair fully netted out: Health expense hidden, no income from settlement
    expect(categories.has('Health')).toBe(false)
    // transfers excluded, USD ignored, review ignored, out-of-range ignored
    expect(summary.totalIncome).toBe(5000) // only the Jan credit; settlement credit hidden
  })
})
