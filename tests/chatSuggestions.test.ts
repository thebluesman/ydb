import { describe, expect, it } from 'vitest'
import {
  MAX_SUGGESTIONS,
  TEMPLATE_ORDER,
  buildSuggestions,
  isMonthOrNarrower,
  longerWindow,
  priorPeriod,
  resolvePeriod,
  sqlFilters,
  suggestionsFrame,
} from '@/lib/chatSuggestions'
import { balanceIntentMatch } from '@/lib/chatBalanceIntent'
import { compoundSelectViolation } from '@/lib/chatCompoundSelect'

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0024. Suggestions are composed by the route from a closed template set,
// never by a model, and every template's preconditions are evaluated against
// the question and the generated SQL.
//
// The properties under test are the ADR's own: each template's precondition
// boundary, the max-three-in-priority-order rule, and — the one that matters
// most in practice — that an unresolvable shape produces silence rather than a
// guess. Nothing here should ever require a model.
// ─────────────────────────────────────────────────────────────────────────────

const TODAY = new Date('2026-07-15T09:00:00.000Z')

const CATEGORIES = ['🍽️ Dining', '🛒 Groceries', '✈️ Travel']
const ACCOUNTS = ['ADCB Credit Card', 'Emirates NBD Savings']

/** A category-filtered month total, the prompt's most-taught shape. */
const CATEGORY_MONTH_SQL =
  `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE category = '🛒 Groceries' ` +
  `AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL ` +
  `AND strftime('%Y-%m', date) = '2026-06' AND status IN ('committed','reconciled')`

/** An account-filtered total over "last month", relative form. */
const ACCOUNT_RELATIVE_SQL =
  `SELECT SUM(-t.amount) / 100.0 AS total_spent FROM "Transaction" t JOIN Account a ON t.accountId = a.id ` +
  `WHERE a.name = 'ADCB Credit Card' AND t.amount < 0 AND t.transactionType != 'transfer' ` +
  `AND t.parentTransactionId IS NULL AND t.reimbursementTxId IS NULL ` +
  `AND strftime('%Y-%m', t.date) = strftime('%Y-%m', date('now','-1 month')) ` +
  `AND t.status IN ('committed','reconciled')`

function build(sql: string, question = 'How much did I spend?', today = TODAY) {
  return buildSuggestions({ question, sql, categories: CATEGORIES, accounts: ACCOUNTS, today })
}

// ── Period resolution ────────────────────────────────────────────────────────

describe('resolvePeriod — shapes the SQL prompt actually teaches', () => {
  it('a literal month', () => {
    expect(resolvePeriod(CATEGORY_MONTH_SQL, TODAY)).toEqual({ kind: 'month', ym: '2026-06' })
  })

  it('a literal year', () => {
    const sql = `SELECT SUM(amount) AS total FROM "Transaction" WHERE strftime('%Y', date) = '2024'`
    expect(resolvePeriod(sql, TODAY)).toEqual({ kind: 'year', y: '2024' })
  })

  it('a relative month resolves against the server clock, not the model', () => {
    expect(resolvePeriod(ACCOUNT_RELATIVE_SQL, TODAY)).toEqual({ kind: 'month', ym: '2026-06' })
  })

  it('a bare relative month is the current month', () => {
    const sql = `SELECT SUM(amount) AS t FROM "Transaction" WHERE strftime('%Y-%m', date) = strftime('%Y-%m', date('now'))`
    expect(resolvePeriod(sql, TODAY)).toEqual({ kind: 'month', ym: '2026-07' })
  })

  it('a relative month crossing a year boundary', () => {
    const sql = `SELECT SUM(amount) AS t FROM "Transaction" WHERE strftime('%Y-%m', date) = strftime('%Y-%m', date('now','-8 months'))`
    expect(resolvePeriod(sql, TODAY)).toEqual({ kind: 'month', ym: '2025-11' })
  })

  it('a relative year', () => {
    const sql = `SELECT SUM(amount) AS t FROM "Transaction" WHERE strftime('%Y', date) = strftime('%Y', date('now'))`
    expect(resolvePeriod(sql, TODAY)).toEqual({ kind: 'year', y: '2026' })
  })

  it('BETWEEN with day bounds', () => {
    const sql = `SELECT SUM(amount) AS t FROM "Transaction" WHERE date BETWEEN '2026-06-03' AND '2026-06-09'`
    expect(resolvePeriod(sql, TODAY)).toEqual({ kind: 'range', start: '2026-06-03', end: '2026-06-09' })
  })

  it('an exclusive upper bound is a whole calendar month, worded as one', () => {
    // The two ways of writing June must not produce two differently-worded
    // suggestions, and the `<` must not be read as inclusive (a one-day shift
    // that would silently move every derived window).
    const sql = `SELECT SUM(amount) AS t FROM "Transaction" WHERE date >= '2026-06-01' AND date < '2026-07-01'`
    expect(resolvePeriod(sql, TODAY)).toEqual({ kind: 'month', ym: '2026-06' })
  })

  it('an inclusive upper bound keeps its own last day', () => {
    const sql = `SELECT SUM(amount) AS t FROM "Transaction" WHERE date >= '2026-06-01' AND date <= '2026-06-14'`
    expect(resolvePeriod(sql, TODAY)).toEqual({ kind: 'range', start: '2026-06-01', end: '2026-06-14' })
  })

  it('a full-year day range is promoted to a year', () => {
    const sql = `SELECT SUM(amount) AS t FROM "Transaction" WHERE date >= '2025-01-01' AND date < '2026-01-01'`
    expect(resolvePeriod(sql, TODAY)).toEqual({ kind: 'year', y: '2025' })
  })
})

describe('resolvePeriod — fails closed', () => {
  it('no date predicate at all', () => {
    expect(resolvePeriod(`SELECT COUNT(*) AS total FROM "Transaction"`, TODAY)).toBeNull()
  })

  it('a rolling window computed at query time is not a nameable period', () => {
    const sql = `SELECT SUM(amount) AS t FROM "Transaction" WHERE date >= date('now','-30 days')`
    expect(resolvePeriod(sql, TODAY)).toBeNull()
  })

  it('a resolved month beside an unresolved `now` expression', () => {
    // The window we CAN read may not be the whole story, so nothing is offered.
    const sql =
      `SELECT SUM(amount) AS t FROM "Transaction" WHERE strftime('%Y-%m', date) = '2026-06' ` +
      `AND date <= date('now','-2 days')`
    expect(resolvePeriod(sql, TODAY)).toBeNull()
  })

  it('two different period predicates are ambiguous', () => {
    const sql =
      `SELECT SUM(amount) AS t FROM "Transaction" WHERE strftime('%Y-%m', date) = '2026-06' ` +
      `AND strftime('%Y', date) = '2026'`
    expect(resolvePeriod(sql, TODAY)).toBeNull()
  })

  it('a lone open-ended lower bound has no prior period to name', () => {
    const sql = `SELECT SUM(amount) AS t FROM "Transaction" WHERE date >= '2026-06-01'`
    expect(resolvePeriod(sql, TODAY)).toBeNull()
  })

  it('an updatedAt bound is not a transaction-date bound', () => {
    // `date` is a substring of `updatedAt`; a boundary-less match here would
    // invent a window out of a housekeeping column.
    const sql = `SELECT COUNT(*) AS t FROM "Transaction" WHERE updatedAt >= '2026-06-01' AND updatedAt < '2026-07-01'`
    expect(resolvePeriod(sql, TODAY)).toBeNull()
  })
})

// ── Derived windows ──────────────────────────────────────────────────────────

describe('priorPeriod / longerWindow / isMonthOrNarrower', () => {
  it('a month steps back one month, across a year boundary', () => {
    expect(priorPeriod({ kind: 'month', ym: '2026-01' })).toEqual({ kind: 'month', ym: '2025-12' })
  })

  it('a year steps back one year', () => {
    expect(priorPeriod({ kind: 'year', y: '2026' })).toEqual({ kind: 'year', y: '2025' })
  })

  it('a day range steps back by its own length', () => {
    expect(priorPeriod({ kind: 'range', start: '2026-06-08', end: '2026-06-14' })).toEqual({
      kind: 'range', start: '2026-06-01', end: '2026-06-07',
    })
  })

  it('a month widens to its year; a year widens to nothing', () => {
    expect(longerWindow({ kind: 'month', ym: '2026-06' })).toEqual({ kind: 'year', y: '2026' })
    expect(longerWindow({ kind: 'year', y: '2026' })).toBeNull()
  })

  it('a sub-month range widens to its containing month', () => {
    expect(longerWindow({ kind: 'range', start: '2026-06-03', end: '2026-06-09' })).toEqual({
      kind: 'month', ym: '2026-06',
    })
  })

  it('a range straddling two months has no month to widen to', () => {
    expect(longerWindow({ kind: 'range', start: '2026-06-20', end: '2026-07-05' })).toBeNull()
  })

  it('the month-or-narrower boundary is 31 days', () => {
    expect(isMonthOrNarrower({ kind: 'month', ym: '2026-06' })).toBe(true)
    expect(isMonthOrNarrower({ kind: 'year', y: '2026' })).toBe(false)
    expect(isMonthOrNarrower({ kind: 'range', start: '2026-06-01', end: '2026-07-01' })).toBe(true)
    expect(isMonthOrNarrower({ kind: 'range', start: '2026-06-01', end: '2026-07-02' })).toBe(false)
  })
})

// ── Filter resolution ────────────────────────────────────────────────────────

describe('sqlFilters — only vocabulary literals are trusted', () => {
  it('reads a category filter off the injected vocabulary', () => {
    const filters = sqlFilters(CATEGORY_MONTH_SQL, CATEGORIES, ACCOUNTS)
    expect(filters).toMatchObject({ kind: 'ok', category: '🛒 Groceries', account: null, grouped: false })
  })

  it('reads an account filter off the injected vocabulary', () => {
    const filters = sqlFilters(ACCOUNT_RELATIVE_SQL, CATEGORIES, ACCOUNTS)
    expect(filters).toMatchObject({ kind: 'ok', category: null, account: 'ADCB Credit Card' })
  })

  it('a LIKE pattern filter is unresolved — there is no honest wording for it', () => {
    const sql = `SELECT SUM(amount) AS t FROM "Transaction" WHERE category LIKE '%Groceries%' AND strftime('%Y-%m', date) = '2026-06'`
    expect(sqlFilters(sql, CATEGORIES, ACCOUNTS).kind).toBe('unresolved')
  })

  it('notices a GROUP BY, and specifically one on category', () => {
    const sql = `${CATEGORY_MONTH_SQL} GROUP BY category`
    expect(sqlFilters(sql, CATEGORIES, ACCOUNTS)).toMatchObject({ grouped: true, groupedByCategory: true })
  })
})

// ── Templates and their precondition boundaries ──────────────────────────────

describe('same-filter-prior-period', () => {
  it('fires whenever a period resolves, carrying the same filters', () => {
    expect(build(CATEGORY_MONTH_SQL)[0]).toEqual({
      text: 'How much did I spend on 🛒 Groceries in May 2026?',
      template: 'same-filter-prior-period',
    })
  })

  it('does not fire when no period resolves', () => {
    expect(build(`SELECT COUNT(*) AS total FROM "Transaction"`)).toEqual([])
  })

  it('a day range shifts by its own length', () => {
    const sql = `SELECT SUM(amount) AS t FROM "Transaction" WHERE date BETWEEN '2026-06-08' AND '2026-06-14'`
    expect(build(sql)[0].text).toBe('How much did I spend between 2026-06-01 and 2026-06-07?')
  })
})

describe('same-filter-longer-window', () => {
  it('fires on a month, widening to the year', () => {
    const texts = build(CATEGORY_MONTH_SQL)
    expect(texts.find((s) => s.template === 'same-filter-longer-window')?.text).toBe(
      'How much did I spend on 🛒 Groceries in 2026?',
    )
  })

  it('does not fire on a year — the rung above is not a period', () => {
    const sql = `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE category = '🛒 Groceries' AND strftime('%Y', date) = '2025'`
    expect(build(sql).map((s) => s.template)).not.toContain('same-filter-longer-window')
  })

  it('does not fire on a range wider than a month', () => {
    const sql = `SELECT SUM(amount) AS t FROM "Transaction" WHERE date BETWEEN '2026-04-01' AND '2026-06-30'`
    expect(build(sql).map((s) => s.template)).not.toContain('same-filter-longer-window')
  })
})

describe('same-period-breakdown', () => {
  it('fires when there is no category filter and the result is not grouped', () => {
    const sql = `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE strftime('%Y-%m', date) = '2026-06'`
    expect(build(sql).find((s) => s.template === 'same-period-breakdown')?.text).toBe(
      'What were my top spending categories in June 2026?',
    )
  })

  it('does not fire when a category filter is present', () => {
    expect(build(CATEGORY_MONTH_SQL).map((s) => s.template)).not.toContain('same-period-breakdown')
  })

  it('does not fire when the result is already grouped', () => {
    const sql =
      `SELECT category, SUM(amount) / 100.0 AS total FROM "Transaction" ` +
      `WHERE strftime('%Y-%m', date) = '2026-06' GROUP BY category ORDER BY total ASC LIMIT 5`
    expect(build(sql).map((s) => s.template)).not.toContain('same-period-breakdown')
  })

  it('a query already grouped by category gets breakdown-shaped siblings, not totals', () => {
    const sql =
      `SELECT category, SUM(amount) / 100.0 AS total FROM "Transaction" ` +
      `WHERE strftime('%Y-%m', date) = '2026-06' GROUP BY category ORDER BY total ASC LIMIT 5`
    expect(build(sql)[0].text).toBe('What were my top spending categories in May 2026?')
  })
})

describe('sibling-account', () => {
  it('fires when an account filter is present and the ledger holds more than one', () => {
    const suggestions = build(ACCOUNT_RELATIVE_SQL, 'How much did I spend on my card last month?')
    // Three fire ahead of it in priority order, so the sibling is squeezed out
    // by the cap — the ordering test below pins that. Raise the cap locally by
    // removing a higher-priority template's precondition instead:
    const yearSql = ACCOUNT_RELATIVE_SQL.replace(
      `strftime('%Y-%m', t.date) = strftime('%Y-%m', date('now','-1 month'))`,
      `strftime('%Y', t.date) = '2025'`,
    )
    const onYear = buildSuggestions({
      question: 'x', sql: yearSql, categories: CATEGORIES, accounts: ACCOUNTS, today: TODAY,
    })
    expect(onYear.find((s) => s.template === 'sibling-account')?.text).toBe(
      'How much did I spend on my Emirates NBD Savings in 2025?',
    )
    expect(suggestions.length).toBe(MAX_SUGGESTIONS)
  })

  it('does not fire without an account filter', () => {
    expect(build(CATEGORY_MONTH_SQL).map((s) => s.template)).not.toContain('sibling-account')
  })

  it('does not fire when the ledger holds only one account', () => {
    const sql = ACCOUNT_RELATIVE_SQL.replace(
      `strftime('%Y-%m', t.date) = strftime('%Y-%m', date('now','-1 month'))`,
      `strftime('%Y', t.date) = '2025'`,
    )
    const only = buildSuggestions({
      question: 'x', sql, categories: CATEGORIES, accounts: ['ADCB Credit Card'], today: TODAY,
    })
    expect(only.map((s) => s.template)).not.toContain('sibling-account')
  })
})

// ── The cap and the ordering ─────────────────────────────────────────────────

describe('at most three, in ADR-0024 priority order', () => {
  it('four eligible templates are cut to three, keeping the highest priority', () => {
    const suggestions = build(ACCOUNT_RELATIVE_SQL)
    expect(suggestions).toHaveLength(3)
    expect(suggestions.map((s) => s.template)).toEqual([
      'same-filter-prior-period',
      'same-filter-longer-window',
      'same-period-breakdown',
    ])
  })

  it('never exceeds the cap on any input', () => {
    for (const sql of [CATEGORY_MONTH_SQL, ACCOUNT_RELATIVE_SQL]) {
      expect(build(sql).length).toBeLessThanOrEqual(MAX_SUGGESTIONS)
    }
  })

  it('the emitted order is always a subsequence of TEMPLATE_ORDER', () => {
    const templates = build(ACCOUNT_RELATIVE_SQL).map((s) => s.template)
    const positions = templates.map((t) => TEMPLATE_ORDER.indexOf(t))
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })
})

// ── Silent omission ──────────────────────────────────────────────────────────

describe('unresolvable shapes degrade silently (ADR-0024)', () => {
  it('no period means no suggestions and no frame', () => {
    const input = {
      question: 'How many transactions do I have?',
      sql: `SELECT COUNT(*) AS total FROM "Transaction" WHERE status IN ('committed','reconciled')`,
      categories: CATEGORIES,
      accounts: ACCOUNTS,
      today: TODAY,
    }
    expect(buildSuggestions(input)).toEqual([])
    expect(suggestionsFrame(input)).toBeNull()
  })

  it('a filter literal outside the vocabulary suppresses everything', () => {
    const sql = CATEGORY_MONTH_SQL.replace(`category = '🛒 Groceries'`, `category LIKE '%Groceries%'`)
    expect(build(sql)).toEqual([])
  })

  it('a frame is emitted, with its declared shape, when there is something to say', () => {
    const frame = suggestionsFrame({
      question: 'How much did I spend on groceries in June?',
      sql: CATEGORY_MONTH_SQL,
      categories: CATEGORIES,
      accounts: ACCOUNTS,
      today: TODAY,
    })
    expect(frame?.type).toBe('suggestions')
    expect(frame?.questions.length).toBeGreaterThan(0)
    for (const q of frame!.questions) {
      expect(typeof q.text).toBe('string')
      expect(TEMPLATE_ORDER).toContain(q.template)
    }
  })

  it('never re-offers the question just asked', () => {
    const question = 'How much did I spend on 🛒 Groceries in May 2026?'
    expect(build(CATEGORY_MONTH_SQL, question).map((s) => s.text)).not.toContain(question)
  })
})

// ── Every template must produce an answerable question ───────────────────────

describe('no template can compose a question the pipeline would refuse', () => {
  const SQLS = [
    CATEGORY_MONTH_SQL,
    ACCOUNT_RELATIVE_SQL,
    `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE strftime('%Y-%m', date) = '2026-06'`,
    `SELECT SUM(amount) AS t FROM "Transaction" WHERE date BETWEEN '2026-06-03' AND '2026-06-09'`,
  ]

  it('none trips the balance-intent check (ADR-0015)', () => {
    for (const sql of SQLS) {
      for (const s of build(sql)) expect(balanceIntentMatch(s.text)).toBeNull()
    }
  })

  it('a vocabulary literal carrying a stock noun is dropped, not offered', () => {
    // A ledger is free to name a category "Debt". The template would compose a
    // grammatically fine question the route would then decline outright, and
    // ADR-0024 says a declined suggestion is worse than no suggestion.
    const categories = ['Debt repayment']
    const sql = `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE category = 'Debt repayment' AND strftime('%Y-%m', date) = '2026-06'`
    const suggestions = buildSuggestions({ question: 'x', sql, categories, accounts: ACCOUNTS, today: TODAY })
    expect(suggestions).toEqual([])
  })

  it('none is a compound select shape (ADR-0011) — they are all plain questions', () => {
    for (const sql of SQLS) {
      for (const s of build(sql)) expect(compoundSelectViolation(s.text)).toBeNull()
    }
  })
})
