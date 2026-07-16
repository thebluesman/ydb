import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { ruleCountQuery, countMatchingTransactions, type RuleInput } from '@/lib/vendor-rule-match'

// Asserts the SQL COUNT built by ruleCountQuery (used by GET
// /api/vendor-rules?withCounts=1) matches the JS matcher countMatchingTransactions
// over the same committed/reconciled rows, including LIKE-wildcard escaping.

type Tx = { description: string; originalDescription: string | null; amount: number; status: string }

const TXNS: Tx[] = [
  { description: 'TESCO STORES 1234',      originalDescription: 'TESCO STORES 1234',      amount: -1500, status: 'committed' },
  { description: 'Tesco Metro',            originalDescription: null,                     amount: -800,  status: 'committed' },
  { description: 'AMAZON UK',              originalDescription: 'AMAZON*MKTP',            amount: -4999, status: 'committed' },
  { description: 'SALARY ACME',            originalDescription: 'SALARY ACME',            amount: 500000, status: 'committed' },
  { description: 'Refund tesco',           originalDescription: 'Refund tesco',           amount: 1500,  status: 'reconciled' },
  { description: '50% OFF PROMO',          originalDescription: '50% OFF PROMO',          amount: -999,  status: 'committed' },
  { description: 'A_B underscore vendor',  originalDescription: 'A_B underscore vendor',  amount: -100,  status: 'committed' },
  { description: 'AXB not underscore',     originalDescription: 'AXB not underscore',     amount: -100,  status: 'committed' },
  { description: 'ignored review row tesco', originalDescription: 'ignored review row tesco', amount: -1, status: 'review' },
]

let db: Database.Database
beforeAll(() => {
  db = new Database(':memory:')
  db.exec(`CREATE TABLE "Transaction" (description TEXT, originalDescription TEXT, amount INTEGER, status TEXT)`)
  const ins = db.prepare(`INSERT INTO "Transaction" VALUES (@description,@originalDescription,@amount,@status)`)
  db.transaction((rows: Tx[]) => rows.forEach((r) => ins.run(r)))(TXNS)
})
afterAll(() => db?.close())

const committed = TXNS.filter((t) => t.status === 'committed' || t.status === 'reconciled')

function sqlCount(rule: RuleInput): number {
  const q = ruleCountQuery(rule)
  if (!q) throw new Error('expected a SQL query')
  const row = db.prepare(q.sql).get(...(q.params as never[])) as { n: number }
  return row.n
}

function rule(partial: Partial<RuleInput>): RuleInput {
  return { pattern: '', matchType: 'contains', direction: 'either', minAmount: null, maxAmount: null, priority: 0, ...partial }
}

describe('ruleCountQuery SQL vs JS matcher', () => {
  const cases: RuleInput[] = [
    rule({ pattern: 'tesco', matchType: 'contains' }),
    rule({ pattern: 'tesco', matchType: 'contains', direction: 'debit' }),
    rule({ pattern: 'tesco', matchType: 'contains', direction: 'credit' }),
    rule({ pattern: 'tesco', matchType: 'starts-with' }),
    rule({ pattern: 'promo', matchType: 'ends-with' }),
    rule({ pattern: 'amazon*mktp', matchType: 'exact' }),
    rule({ pattern: '50%', matchType: 'contains' }),         // literal % must be escaped
    rule({ pattern: 'a_b', matchType: 'contains' }),          // literal _ must be escaped (not match AXB)
    rule({ pattern: 'tesco', matchType: 'contains', minAmount: 1000 }),
    rule({ pattern: 'tesco', matchType: 'contains', minAmount: 1000, maxAmount: 2000 }),
  ]

  for (const [i, r] of cases.entries()) {
    it(`case ${i}: ${r.matchType} "${r.pattern}" dir=${r.direction} min=${r.minAmount} max=${r.maxAmount}`, () => {
      expect(sqlCount(r)).toBe(countMatchingTransactions(r, committed))
    })
  }

  it('regex rules return null (JS fallback)', () => {
    expect(ruleCountQuery(rule({ pattern: 'tes.o', matchType: 'regex' }))).toBeNull()
  })

  it('the escaping cases are non-trivial (guards against a vacuous test)', () => {
    // "50%" contains-escaped matches exactly the one 50% row, not everything.
    expect(sqlCount(rule({ pattern: '50%', matchType: 'contains' }))).toBe(1)
    // "a_b" must NOT match "AXB" (underscore is a literal, not a wildcard).
    expect(sqlCount(rule({ pattern: 'a_b', matchType: 'contains' }))).toBe(1)
  })
})
