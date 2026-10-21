import { describe, expect, it } from 'vitest'
import { buildFixtureDb, fixtureAccountSource, fixtureCategorySource, pinSqlNow } from '@/scripts/chatEval/fixtureDb'
import { GOLDEN_QUERIES, groundTruthValue } from '@/scripts/chatEval/goldenQueries'
import { loadAccountVocabulary } from '@/lib/chatAccountVocabulary'
import { loadCategoryVocabulary } from '@/lib/chatCategoryVocabulary'

// ─────────────────────────────────────────────────────────────────────────────
// [chat-eval] — this does NOT call Ollama and does NOT run scripts/evalChatSql.ts
// (that needs a live model, real wall-clock time, and its outcome depends on
// which model is configured — none of which belongs in `npm test`).
//
// What this DOES protect: the fixture ledger and its ground-truth SQL are the
// specification the eval harness measures the model against. If either drifts
// silently — a seed row edited, a ground-truth query typo'd — the harness's
// pass/fail numbers stop meaning what this file's comments say they mean, with
// no signal until someone runs the (slow, live) eval and gets confused. These
// are deterministic snapshots of the FIXTURE, not of model behavior.
// ─────────────────────────────────────────────────────────────────────────────

describe('fixture vocabulary loaders resolve against the fixture DB', () => {
  it('categories match the seeded set', async () => {
    const db = buildFixtureDb()
    const categories = await loadCategoryVocabulary(fixtureCategorySource(db))
    expect(categories).toEqual([
      'Auto Loan Payment', 'Dining', 'Groceries', 'Household', 'Rent',
      'Salary', 'Shopping', 'Travel', 'Uncategorized',
    ])
  })

  it('accounts match the seeded set', async () => {
    const db = buildFixtureDb()
    const accounts = await loadAccountVocabulary(fixtureAccountSource(db))
    expect(accounts).toEqual(['Car Loan', 'Emergency Savings', 'Main Checking', 'Rewards Card'])
  })
})

describe('every golden query\'s ground-truth SQL runs and matches its documented value', () => {
  const db = buildFixtureDb()

  // Pinned expected values, independent of goldenQueries.ts's own tolerance
  // settings — a change to either the fixture data or a ground-truth query
  // should show up here as a diff, not silently pass because the eval
  // harness's own tolerance absorbed it.
  const EXPECTED: Record<string, number> = {
    'groceries-last-month': -235,
    'dining-last-month': -105,
    'rent-last-month': -1500,
    'shopping-split-leg': -200,
    'travel-reimbursement-netting': -80,
    'total-income-reimbursement-aware': 5000,
    'reimbursements-received-last-month': 300,
    'total-expenses-last-month': -2120,
    'transfer-volume-non-cancellation': 1500,
    'car-loan-payment-transfer-mirror-case': -500,
    'transaction-count': 18,
    'account-filtered-category': -30,
    'this-month-income': 5000,
    'rent-this-year': -3000,
    'groceries-transaction-count': 3,
    'average-grocery-transaction': -78.33333333333333,
    'income-and-expenses-together': 5000,
    'percentage-of-spending-derived-ratio': 11.084905660377359,
  }

  for (const gq of GOLDEN_QUERIES) {
    if (gq.expect.kind === 'refusal') continue
    const expected = EXPECTED[gq.id]
    it(`${gq.id}: ${expected}`, () => {
      expect(expected, `add an EXPECTED entry for ${gq.id}`).toBeDefined()
      const actual = groundTruthValue(db, (gq.expect as { sql: string }).sql)
      expect(actual).toBeCloseTo(expected, 5)
    })
  }

  it('every non-refusal fixture has a pinned expected value (no silent gaps)', () => {
    const valueFixtures = GOLDEN_QUERIES.filter((g) => g.expect.kind !== 'refusal').map((g) => g.id)
    expect(Object.keys(EXPECTED).sort()).toEqual([...valueFixtures].sort())
  })
})

describe('refusal-expected fixtures have no ground-truth SQL to drift', () => {
  it('lists exactly the questions this harness expects the pipeline to decline', () => {
    const refusals = GOLDEN_QUERIES.filter((g) => g.expect.kind === 'refusal').map((g) => g.id)
    expect(refusals).toEqual([
      'balance-question-refused',
      'owed-question-refused',
      'unmatched-category-refused',
      'no-transactions-this-category-no-data',
      'household-split-leg-visibility',
    ])
  })
})

describe('pinSqlNow — model SQL reads REFERENCE_NOW, not the real clock', () => {
  it("rewrites every 'now' time-value literal, leaving modifiers alone", () => {
    expect(pinSqlNow("SELECT 1 WHERE strftime('%Y-%m', date) = strftime('%Y-%m', date('now','-1 month')) AND date >= date('NOW','start of month')"))
      .toBe("SELECT 1 WHERE strftime('%Y-%m', date) = strftime('%Y-%m', date('2026-08-03 12:00:00','-1 month')) AND date >= date('2026-08-03 12:00:00','start of month')")
  })

  it('rewrites the CURRENT_* keywords to the matching literal', () => {
    expect(pinSqlNow('SELECT CURRENT_DATE, current_timestamp, CURRENT_TIME'))
      .toBe("SELECT '2026-08-03', '2026-08-03 12:00:00', '12:00:00'")
  })

  it('leaves other literals, and keyword text inside a literal, untouched', () => {
    const sql = "SELECT 1 WHERE description = 'nowhere CURRENT_DATE' AND category = 'O''Brien'"
    expect(pinSqlNow(sql)).toBe(sql)
  })

  it('returns malformed quoting unchanged', () => {
    const sql = "SELECT date('now) FROM x"
    expect(pinSqlNow(sql)).toBe(sql)
  })

  it("makes a relative 'last month' query find the fixture's July rows whatever today is", () => {
    const db = buildFixtureDb()
    const sql = `SELECT COUNT(*) AS n FROM "Transaction" WHERE strftime('%Y-%m', date) = strftime('%Y-%m', date('now','-1 month'))`
    const row = db.prepare(pinSqlNow(sql)).get() as { n: number }
    expect(row.n).toBeGreaterThan(0)
  })
})
