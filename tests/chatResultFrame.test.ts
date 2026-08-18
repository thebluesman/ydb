import { describe, expect, it } from 'vitest'
import { buildResultFrame, CHART_MAX_ROWS, classifyPresent, resultColumnKeys } from '@/lib/chatResultFrame'
import { moneyUnitsPlan } from '@/lib/chatMoneyUnits'

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0023. `present` is a deterministic function of the final rows, chosen by
// the route — never emitted by the narration model — and `columns[].kind` is
// 'money' exactly where the plan's `moneyKeys` names the column (ADR-0027,
// correcting ADR-0023's original `convertKeys` rule).
// ─────────────────────────────────────────────────────────────────────────────

const TX_ROW = {
  id: 1,
  date: '2026-07-14',
  amount: -12.5,
  description: 'Coffee',
  category: '🛒 Groceries',
}

describe('classifyPresent — card', () => {
  it('one row and one column is a card', () => {
    expect(classifyPresent([{ total_spent: 1234.5 }])).toBe('card')
  })

  it('one row with two columns is a table, not a card', () => {
    expect(classifyPresent([{ total_spent: 1234.5, txn_count: 12 }])).toBe('table')
  })

  it('two rows of one column is a table, not a card', () => {
    expect(classifyPresent([{ category: 'a' }, { category: 'b' }])).toBe('table')
  })
})

describe('classifyPresent — transactions', () => {
  it('many rows whose keys are all Transaction columns, including date and amount', () => {
    expect(classifyPresent([TX_ROW, { ...TX_ROW, id: 2 }])).toBe('transactions')
  })

  it('is case-insensitive on the column names SQLite echoes back', () => {
    const rows = [
      { DATE: '2026-07-14', AMOUNT: -12.5 },
      { DATE: '2026-07-15', AMOUNT: -3 },
    ]
    expect(classifyPresent(rows)).toBe('transactions')
  })

  it('falls back to table when one key is not a Transaction column', () => {
    const rows = [
      { ...TX_ROW, account_name: 'ADCB Current' },
      { ...TX_ROW, id: 2, account_name: 'ADCB Current' },
    ]
    expect(classifyPresent(rows)).toBe('table')
  })

  it('falls back to table when date is missing', () => {
    const rows = [{ id: 1, amount: -12.5 }, { id: 2, amount: -3 }]
    expect(classifyPresent(rows)).toBe('table')
  })

  it('falls back to table when amount is missing', () => {
    // A third column keeps this out of ADR-0030's 2-column chart shape too —
    // {id, date} alone would now legitimately classify as `chart` (a date
    // dimension plus a numeric value is exactly that shape), which would test
    // the chart rule instead of the thing this case exists to check: that
    // "transactions" itself refuses a Transaction-column row set missing `amount`.
    const rows = [
      { id: 1, date: '2026-07-14', status: 'committed' },
      { id: 2, date: '2026-07-15', status: 'committed' },
    ]
    expect(classifyPresent(rows)).toBe('table')
  })

  it('a single transaction row is not "transactions" — the rule needs more than one row', () => {
    expect(classifyPresent([TX_ROW])).toBe('table')
  })
})

describe('classifyPresent — chart (ADR-0030)', () => {
  it('a 2-row category breakdown (text + number) is a chart', () => {
    const rows = [
      { category: '🛒 Groceries', total: 400 },
      { category: '✈️ Travel', total: 900 },
    ]
    expect(classifyPresent(rows)).toBe('chart')
  })

  it('a date + money trend is a chart', () => {
    const rows = [
      { month: '2026-06-01', total_spent: 1200.5 },
      { month: '2026-07-01', total_spent: 980.25 },
    ]
    expect(classifyPresent(rows)).toBe('chart')
  })

  it('respects the column-kind map so a money-classified key counts as the value column', () => {
    const rows = [
      { category: '🛒 Groceries', total_spent: 400 },
      { category: '✈️ Travel', total_spent: 900 },
    ]
    const kinds = new Map<string, 'money' | 'date' | 'number' | 'text'>([
      ['category', 'text'],
      ['total_spent', 'money'],
    ])
    expect(classifyPresent(rows, undefined, kinds)).toBe('chart')
  })

  it('exactly CHART_MAX_ROWS rows is still a chart', () => {
    const rows = Array.from({ length: CHART_MAX_ROWS }, (_, i) => ({ category: `cat${i}`, total: i * 10 }))
    expect(classifyPresent(rows)).toBe('chart')
  })

  it('falls back to table beyond CHART_MAX_ROWS — overflow is never truncated to fit', () => {
    const rows = Array.from({ length: CHART_MAX_ROWS + 1 }, (_, i) => ({ category: `cat${i}`, total: i * 10 }))
    expect(classifyPresent(rows)).toBe('table')
  })

  it('falls back to table with 3 columns — v1 is strictly one dimension, one value', () => {
    const rows = [
      { category: '🛒 Groceries', total: 400, txn_count: 5 },
      { category: '✈️ Travel', total: 900, txn_count: 2 },
    ]
    expect(classifyPresent(rows)).toBe('table')
  })

  it('falls back to table when both columns are values (no dimension)', () => {
    const rows = [
      { total_spent: 400, txn_count: 5 },
      { total_spent: 900, txn_count: 2 },
    ]
    expect(classifyPresent(rows)).toBe('table')
  })

  it('falls back to table when both columns are dimensions (no value)', () => {
    const rows = [
      { category: '🛒 Groceries', account: 'ADCB Current' },
      { category: '✈️ Travel', account: 'ADCB Savings' },
    ]
    expect(classifyPresent(rows)).toBe('table')
  })
})

describe('classifyPresent — table is the catch-all', () => {
  it('an empty result set is a table (the route never gets here — no-data short-circuits)', () => {
    expect(classifyPresent([])).toBe('table')
  })
})

describe('resultColumnKeys', () => {
  it('preserves first-seen order across rows', () => {
    expect(resultColumnKeys([{ b: 1, a: 2 }, { c: 3 }])).toEqual(['b', 'a', 'c'])
  })
})

describe('buildResultFrame — columns and money derivation', () => {
  it('marks exactly the keys moneyUnitsPlan named as money', () => {
    const sql = `SELECT category, SUM(amount) AS total_spent, COUNT(*) AS txn_count FROM "Transaction" GROUP BY category`
    expect(moneyUnitsPlan(sql)).toMatchObject({ kind: 'ok', moneyKeys: ['total_spent'] })

    const frame = buildResultFrame({
      rows: [{ category: '🛒 Groceries', total_spent: 400.5, txn_count: 12 }],
      plan: moneyUnitsPlan(sql),
      currency: 'AED',
      truncated: null,
    })

    expect(frame.columns).toEqual([
      { key: 'category', label: 'category', kind: 'text' },
      { key: 'total_spent', label: 'total_spent', kind: 'money' },
      { key: 'txn_count', label: 'txn_count', kind: 'number' },
    ])
    expect(frame.currency).toBe('AED')
    expect(frame.type).toBe('result')
  })

  it('star-expanded money columns are money (ADR-0020 rule (a))', () => {
    const sql = `SELECT * FROM "Transaction" LIMIT 2`
    const frame = buildResultFrame({
      rows: [TX_ROW, { ...TX_ROW, id: 2 }],
      plan: moneyUnitsPlan(sql),
      currency: 'AED',
      truncated: null,
    })

    const kinds = Object.fromEntries(frame.columns.map((c) => [c.key, c.kind]))
    expect(kinds).toEqual({
      id: 'number', date: 'date', amount: 'money', description: 'text', category: 'text',
    })
    expect(frame.present).toBe('transactions')
  })

  it('an already-converted column (a /100 in the projection) is money (ADR-0027)', () => {
    const sql = `SELECT SUM(amount) / 100.0 AS total FROM "Transaction"`
    const frame = buildResultFrame({ rows: [{ total: 123.45 }], plan: moneyUnitsPlan(sql), currency: 'AED', truncated: null })
    // ADR-0027 corrects ADR-0023 here. The plan converts nothing — every one of
    // the SQL prompt's worked examples divides by 100 itself — and classifying
    // off `convertKeys` made this common shape a bare 'number', rendered via
    // toLocaleString with no currency at all. `money` now means "this is a
    // currency figure", not "this route divided it"; the values are in currency
    // units either way and the client formats, never converts.
    expect(frame.columns).toEqual([{ key: 'total', label: 'total', kind: 'money' }])
    expect(frame.present).toBe('card')
  })

  it('labels are the alias verbatim — no prettifying (ADR-0010)', () => {
    const sql = `SELECT SUM(amount) AS total_spent FROM "Transaction"`
    const frame = buildResultFrame({ rows: [{ total_spent: 1 }], plan: moneyUnitsPlan(sql), currency: 'AED', truncated: null })
    expect(frame.columns[0].label).toBe('total_spent')
  })

  it('a refused plan yields no money columns rather than throwing (unreachable from the route)', () => {
    const sql = `WITH x AS (SELECT SUM(amount) AS s FROM "Transaction") SELECT s AS total FROM x`
    expect(moneyUnitsPlan(sql).kind).toBe('refuse')
    const frame = buildResultFrame({ rows: [{ total: 5 }], plan: moneyUnitsPlan(sql), currency: 'AED', truncated: null })
    expect(frame.columns[0].kind).toBe('number')
  })

  it('carries the truncation summary through verbatim', () => {
    const frame = buildResultFrame({
      rows: [{ a: 1 }, { a: 2 }],
      plan: moneyUnitsPlan('SELECT a FROM "Transaction"'),
      currency: 'AED',
      truncated: { shown: 20, total: 137, dbCapped: false },
    })
    expect(frame.truncated).toEqual({ shown: 20, total: 137, dbCapped: false })
  })

  it('a Date value classifies as a date column', () => {
    const frame = buildResultFrame({
      rows: [{ when: new Date('2026-07-14') }],
      plan: moneyUnitsPlan('SELECT date AS when FROM "Transaction"'),
      currency: 'AED',
      truncated: null,
    })
    expect(frame.columns[0].kind).toBe('date')
  })

  it('a leading NULL does not decide the kind — the first non-null value does', () => {
    const frame = buildResultFrame({
      rows: [{ note: null }, { note: 'hello' }, { note: 'world' }],
      plan: moneyUnitsPlan('SELECT notes AS note FROM "Transaction"'),
      currency: 'AED',
      truncated: null,
    })
    expect(frame.columns[0].kind).toBe('text')
  })
})
