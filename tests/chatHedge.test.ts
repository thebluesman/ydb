import { describe, expect, it } from 'vitest'
import {
  hedgeGrounds,
  hedgeInstruction,
  isAggregateQuery,
  periodReachesToday,
  smallestCount,
  SMALL_SAMPLE_MAX,
} from '@/lib/chatHedge'

// ─────────────────────────────────────────────────────────────────────────────
// [chat-model] output 5's classifier.
//
// Half these tests assert that NOTHING fires. That is the point: an assistant
// that qualifies a fully-scoped closed-month total teaches the reader to skip
// the qualification, so the no-caveat cases are as load-bearing as the caveat
// cases and are pinned just as hard.
// ─────────────────────────────────────────────────────────────────────────────

const TODAY = new Date(2026, 7, 3) // 2026-08-03, mid-month on purpose

const CLOSED_MONTH_SQL =
  `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" ` +
  `WHERE category = '🛒 Groceries' AND date >= '2026-07-01' AND date < '2026-08-01' LIMIT 200`

const OPEN_MONTH_SQL =
  `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" ` +
  `WHERE date >= '2026-08-01' AND date < '2026-09-01' LIMIT 200`

const LIST_SQL =
  `SELECT date, description, amount / 100.0 AS amount FROM "Transaction" ` +
  `WHERE date >= '2026-07-01' AND date < '2026-08-01' ORDER BY date LIMIT 200`

function grounds(over: Partial<Parameters<typeof hedgeGrounds>[0]>) {
  return hedgeGrounds({
    question: 'How much did I spend on groceries last month?',
    sql: CLOSED_MONTH_SQL,
    rows: [{ total: 812.4 }],
    truncated: false,
    today: TODAY,
    ...over,
  })
}

describe('hedgeGrounds — the silent case', () => {
  // The case Shyam named explicitly when scoping this.
  it('says nothing about a fully-scoped single-category total for a closed month', () => {
    expect(grounds({})).toEqual([])
  })

  it('says nothing about a closed-month list', () => {
    expect(grounds({ sql: LIST_SQL, rows: [{ date: '2026-07-04', amount: 12 }] })).toEqual([])
  })

  // A window whose upper bound is exactly the first of this month is closed —
  // the boundary that decides most real queries, so it gets its own test.
  it('treats an upper bound at the start of the current month as closed', () => {
    expect(periodReachesToday(CLOSED_MONTH_SQL, TODAY)).toBe(false)
  })

  it('says nothing when a count column is comfortably above the small-sample line', () => {
    expect(grounds({ rows: [{ total: 812.4, txn_count: SMALL_SAMPLE_MAX + 1 }] })).toEqual([])
  })
})

describe('hedgeGrounds — partial-period', () => {
  it('fires when the query window runs past today', () => {
    expect(grounds({ sql: OPEN_MONTH_SQL, question: 'How much have I spent in August?' }))
      .toEqual(['partial-period'])
  })

  it('fires on the question wording even when the SQL dates are ambiguous', () => {
    expect(grounds({
      sql: `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE strftime('%Y-%m', date) = ?`,
      question: 'What have I spent this month?',
    })).toEqual(['partial-period'])
  })

  it.each([
    'How am I doing so far?',
    'What is my year-to-date spend?',
    'Show me MTD dining',
    'How much this quarter?',
  ])('recognises open-period wording: %s', (question) => {
    expect(grounds({ question })).toEqual(['partial-period'])
  })

  it('fires on a query-time relative date', () => {
    expect(periodReachesToday(`SELECT SUM(amount) FROM "Transaction" WHERE date >= date('now', '-7 days')`, TODAY))
      .toBe(true)
  })

  // A list is exactly what it is; only a claim about a population can have a
  // silently-open boundary.
  it('does not fire on a non-aggregate query, whatever the window', () => {
    expect(grounds({
      sql: LIST_SQL.replace("date < '2026-08-01'", "date < '2026-09-01'"),
      question: 'What did I buy this month?',
    })).toEqual([])
  })
})

describe('hedgeGrounds — truncated-rows', () => {
  it('fires whenever rows were cut, aggregate or not', () => {
    expect(grounds({ truncated: true })).toEqual(['truncated-rows'])
    expect(grounds({ sql: LIST_SQL, truncated: true })).toEqual(['truncated-rows'])
  })
})

describe('hedgeGrounds — small-sample', () => {
  it('fires when a count column shows a handful of transactions', () => {
    expect(grounds({ rows: [{ total: 812.4, txn_count: SMALL_SAMPLE_MAX }] })).toEqual(['small-sample'])
  })

  it('uses the smallest count across grouped rows', () => {
    expect(smallestCount([{ n: 40 }, { n: 2 }])).toBe(2)
    expect(grounds({ rows: [{ category: 'a', n: 40 }, { category: 'b', n: 2 }] })).toEqual(['small-sample'])
  })

  it('ignores non-count columns, and money that merely looks small', () => {
    expect(smallestCount([{ total: 2.5, average_amount: 1 }])).toBe(null)
    expect(grounds({ rows: [{ total: 1 }] })).toEqual([])
  })

  it('ignores a fractional value under a count-ish alias', () => {
    expect(smallestCount([{ count: 2.5 }])).toBe(null)
  })
})

describe('hedgeGrounds — combinations', () => {
  it('reports every ground that applies, in a stable order', () => {
    expect(grounds({
      sql: OPEN_MONTH_SQL,
      question: 'What are my top categories this month?',
      rows: [{ category: 'a', total: 10, n: 1 }],
      truncated: true,
    })).toEqual(['partial-period', 'truncated-rows', 'small-sample'])
  })
})

describe('hedgeInstruction', () => {
  it('is empty when nothing applies, so the route appends nothing', () => {
    expect(hedgeInstruction([])).toBe('')
  })

  it('names the specific caveat and demands the number first', () => {
    const text = hedgeInstruction(['partial-period'])
    expect(text).toContain('still in progress')
    expect(text).toMatch(/number first/i)
    expect(text).toMatch(/say it once/i)
  })

  it('bars the model from inventing further qualifications', () => {
    expect(hedgeInstruction(['small-sample'])).toMatch(/do not add any other qualification/i)
  })

  it('lists each ground once when several apply', () => {
    const text = hedgeInstruction(['partial-period', 'truncated-rows'])
    expect(text).toContain('still in progress')
    expect(text).toContain('more rows matched')
  })
})

describe('isAggregateQuery', () => {
  it.each(['SUM(amount)', 'sum( amount )', 'COUNT(*)', 'AVG(amount)', 'MIN(date)', 'TOTAL(amount)'])(
    'recognises %s',
    (fragment) => expect(isAggregateQuery(`SELECT ${fragment} FROM "Transaction"`)).toBe(true),
  )

  it('does not treat a plain projection as an aggregate', () => {
    expect(isAggregateQuery(LIST_SQL)).toBe(false)
  })
})
