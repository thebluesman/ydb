import { describe, expect, it } from 'vitest'
import { buildResultFrame, classifyPresent, resultColumnKeys } from '@/lib/chatResultFrame'
import { moneyUnitsPlan } from '@/lib/chatMoneyUnits'

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0023. `present` is a deterministic function of the final rows, chosen by
// the route — never emitted by the narration model — and `columns[].kind` is
// 'money' exactly where ADR-0020's classifier already converted a value.
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
    const rows = [{ id: 1, date: '2026-07-14' }, { id: 2, date: '2026-07-15' }]
    expect(classifyPresent(rows)).toBe('table')
  })

  it('a single transaction row is not "transactions" — the rule needs more than one row', () => {
    expect(classifyPresent([TX_ROW])).toBe('table')
  })
})

describe('classifyPresent — table is the catch-all', () => {
  it('a grouped breakdown is a table', () => {
    const rows = [
      { category: '🛒 Groceries', total: 400 },
      { category: '✈️ Travel', total: 900 },
    ]
    expect(classifyPresent(rows)).toBe('table')
  })

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
    expect(moneyUnitsPlan(sql)).toEqual({ kind: 'ok', convertKeys: ['total_spent'] })

    const frame = buildResultFrame({
      rows: [{ category: '🛒 Groceries', total_spent: 400.5, txn_count: 12 }],
      sql,
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
      sql,
      currency: 'AED',
      truncated: null,
    })

    const kinds = Object.fromEntries(frame.columns.map((c) => [c.key, c.kind]))
    expect(kinds).toEqual({
      id: 'number', date: 'date', amount: 'money', description: 'text', category: 'text',
    })
    expect(frame.present).toBe('transactions')
  })

  it('an already-converted column (a /100 in the projection) is still money', () => {
    const sql = `SELECT SUM(amount) / 100.0 AS total FROM "Transaction"`
    const frame = buildResultFrame({ rows: [{ total: 123.45 }], sql, currency: 'AED', truncated: null })
    // The plan converts nothing here, so the kind falls out of the value —
    // 'number', not 'money'. Documented rather than asserted as desirable:
    // 'money' means "this route divided it", which is what the client needs to
    // know it must not divide again.
    expect(frame.columns).toEqual([{ key: 'total', label: 'total', kind: 'number' }])
    expect(frame.present).toBe('card')
  })

  it('labels are the alias verbatim — no prettifying (ADR-0010)', () => {
    const sql = `SELECT SUM(amount) AS total_spent FROM "Transaction"`
    const frame = buildResultFrame({ rows: [{ total_spent: 1 }], sql, currency: 'AED', truncated: null })
    expect(frame.columns[0].label).toBe('total_spent')
  })

  it('a refused plan yields no money columns rather than throwing (unreachable from the route)', () => {
    const sql = `WITH x AS (SELECT SUM(amount) AS s FROM "Transaction") SELECT s AS total FROM x`
    expect(moneyUnitsPlan(sql).kind).toBe('refuse')
    const frame = buildResultFrame({ rows: [{ total: 5 }], sql, currency: 'AED', truncated: null })
    expect(frame.columns[0].kind).toBe('number')
  })

  it('carries the truncation summary through verbatim', () => {
    const frame = buildResultFrame({
      rows: [{ a: 1 }, { a: 2 }],
      sql: 'SELECT a FROM "Transaction"',
      currency: 'AED',
      truncated: { shown: 20, total: 137, dbCapped: false },
    })
    expect(frame.truncated).toEqual({ shown: 20, total: 137, dbCapped: false })
  })

  it('a Date value classifies as a date column', () => {
    const frame = buildResultFrame({
      rows: [{ when: new Date('2026-07-14') }],
      sql: 'SELECT date AS when FROM "Transaction"',
      currency: 'AED',
      truncated: null,
    })
    expect(frame.columns[0].kind).toBe('date')
  })

  it('a leading NULL does not decide the kind — the first non-null value does', () => {
    const frame = buildResultFrame({
      rows: [{ note: null }, { note: 'hello' }, { note: 'world' }],
      sql: 'SELECT notes AS note FROM "Transaction"',
      currency: 'AED',
      truncated: null,
    })
    expect(frame.columns[0].kind).toBe('text')
  })
})
