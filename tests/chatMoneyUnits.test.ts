import { describe, expect, it } from 'vitest'
import { applyMoneyUnits, moneyUnitsPlan } from '@/lib/chatMoneyUnits'

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0020: units are decided server-side, before rows reach narration. Money
// columns are Transaction.amount and Account.creditLimit (plus the two
// balance-scope-banned columns, included only for completeness — they can
// never actually reach this classifier, the balance-scope guards run first).
//
// This is NOT an arithmetic-correctness verifier. A projection that already
// contains a `/100` is trusted as converted even if the surrounding expression
// computes the wrong number — that is a correctness question the golden-query
// eval harness answers, not a units question this classifier can.
// ─────────────────────────────────────────────────────────────────────────────

describe('moneyUnitsPlan — resolvable shapes convert', () => {
  it('a bare row-level amount column converts', () => {
    const sql = `SELECT date, description, amount FROM "Transaction" WHERE parentTransactionId IS NULL LIMIT 5`
    expect(moneyUnitsPlan(sql)).toEqual({ kind: 'ok', convertKeys: ['amount'] })
  })

  it('a qualified row-level amount column converts under its own name', () => {
    const sql = `SELECT t.date, t.amount FROM "Transaction" t JOIN Account a ON t.accountId = a.id`
    expect(moneyUnitsPlan(sql)).toEqual({ kind: 'ok', convertKeys: ['amount'] })
  })

  it('SELECT * over a single known table converts its money sub-columns', () => {
    expect(moneyUnitsPlan(`SELECT * FROM "Transaction" WHERE parentTransactionId IS NULL LIMIT 5`))
      .toEqual({ kind: 'ok', convertKeys: ['amount'] })
    expect(moneyUnitsPlan(`SELECT * FROM Account`)).toEqual({
      kind: 'ok',
      convertKeys: ['creditLimit', 'openingBalance', 'lastReconciledBalance'],
    })
  })

  it('a qualified star over a multi-table join resolves to its own table, not ambiguous', () => {
    const sql = `SELECT t.* FROM "Transaction" t JOIN Account a ON t.accountId = a.id`
    expect(moneyUnitsPlan(sql)).toEqual({ kind: 'ok', convertKeys: ['amount'] })
  })

  it('Account.creditLimit converts', () => {
    const sql = `SELECT name, creditLimit FROM Account WHERE accountType = 'credit'`
    expect(moneyUnitsPlan(sql)).toEqual({ kind: 'ok', convertKeys: ['creditLimit'] })
  })

  it('a bare negated amount converts under its own alias', () => {
    const sql = `SELECT -amount AS spent FROM "Transaction" WHERE amount < 0 LIMIT 1`
    expect(moneyUnitsPlan(sql)).toEqual({ kind: 'ok', convertKeys: ['spent'] })
  })

  it('SUM(amount) with no /100.0 converts as a safety net for a forgotten conversion', () => {
    const sql = `SELECT SUM(amount) AS total FROM "Transaction"`
    expect(moneyUnitsPlan(sql)).toEqual({ kind: 'ok', convertKeys: ['total'] })
  })

  it('a CASE aggregate whose branches all resolve to the same money column converts', () => {
    const sql = `SELECT SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS total_expenses FROM "Transaction"`
    expect(moneyUnitsPlan(sql)).toEqual({ kind: 'ok', convertKeys: ['total_expenses'] })
  })
})

describe('moneyUnitsPlan — already-converted shapes are left untouched', () => {
  it('SUM(amount) / 100.0 is not double-divided', () => {
    const sql = `SELECT SUM(amount) / 100.0 AS total FROM "Transaction"`
    expect(moneyUnitsPlan(sql)).toEqual({ kind: 'ok', convertKeys: [] })
  })

  it('the shipped two-figure worked example (both branches carry /100.0) is left alone', () => {
    const sql =
      `SELECT SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) / 100.0 AS total_expenses, ` +
      `SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) / 100.0 AS total_income FROM "Transaction"`
    expect(moneyUnitsPlan(sql)).toEqual({ kind: 'ok', convertKeys: [] })
  })

  it('the shipped account-join worked example (qualified column, /100.0, multi-table JOIN) is left alone', () => {
    const sql =
      `SELECT SUM(-t.amount) / 100.0 AS total_spent FROM "Transaction" t JOIN Account a ON t.accountId = a.id ` +
      `WHERE a.name = 'ADCB Credit Card'`
    expect(moneyUnitsPlan(sql)).toEqual({ kind: 'ok', convertKeys: [] })
  })

  it('a ratio expression that already divides by 100 is left alone, even if the division is misplaced', () => {
    // The live-reproduced [chat-bug] finding: this SQL computes a WRONG number
    // (unit-conversion applied inside a ratio, ~100x too small), but that is an
    // arithmetic-correctness bug, not a units bug — this classifier is not an
    // arithmetic verifier and must not pretend otherwise by "fixing" it, which
    // would silently mask the real defect rather than surface it.
    const sql =
      `SELECT ((SUM(CASE WHEN a.name = 'DIB' THEN t.amount ELSE 0 END) / 100.0) * 100.0 / ` +
      `SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END) / 100.0) AS percentage_spent ` +
      `FROM "Transaction" t JOIN Account a ON t.accountId = a.id`
    expect(moneyUnitsPlan(sql)).toEqual({ kind: 'ok', convertKeys: [] })
  })
})

describe('moneyUnitsPlan — not money, left untouched regardless of complexity', () => {
  it('COUNT(...) is never money, even COUNT(amount)', () => {
    expect(moneyUnitsPlan(`SELECT COUNT(amount) AS n FROM "Transaction"`))
      .toEqual({ kind: 'ok', convertKeys: [] })
    expect(moneyUnitsPlan(`SELECT COUNT(*) AS n FROM "Transaction"`))
      .toEqual({ kind: 'ok', convertKeys: [] })
  })

  it('a projection referencing no money column is left alone, however complex', () => {
    const sql = `SELECT category, strftime('%Y-%m', date) AS ym, COUNT(*) AS n FROM "Transaction" GROUP BY category, ym`
    expect(moneyUnitsPlan(sql)).toEqual({ kind: 'ok', convertKeys: [] })
  })
})

describe('moneyUnitsPlan — unresolvable shapes are refused (ADR-0014 unsupported-shape)', () => {
  it('any CTE refuses the whole query outright', () => {
    expect(moneyUnitsPlan(`WITH x AS (SELECT 1) SELECT * FROM x`)).toEqual({ kind: 'refuse' })
  })

  it('a bare star over a multi-table join is ambiguous and refuses', () => {
    const sql = `SELECT * FROM "Transaction" t JOIN Account a ON t.accountId = a.id`
    expect(moneyUnitsPlan(sql)).toEqual({ kind: 'refuse' })
  })

  it('a money-referencing ratio with no /100 anywhere refuses rather than guess', () => {
    // Never dividing would report a raw-cents ratio; always dividing by 100
    // would be wrong for an expression that was never in cents to begin with —
    // a bare fraction of two aggregates has no single well-defined unit rule,
    // so this is refused rather than guessed, per ADR-0020's fail-closed stance.
    const sql =
      `SELECT SUM(CASE WHEN category = 'Groceries' THEN -amount ELSE 0 END) / ` +
      `SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS pct FROM "Transaction"`
    expect(moneyUnitsPlan(sql)).toEqual({ kind: 'refuse' })
  })

  it('an aggregate with no alias and no /100 refuses — the result key cannot be safely determined', () => {
    const sql = `SELECT SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) FROM "Transaction"`
    expect(moneyUnitsPlan(sql)).toEqual({ kind: 'refuse' })
  })

  it('a CASE whose branches resolve to different money columns refuses', () => {
    const sql =
      `SELECT SUM(CASE WHEN a.accountType = 'credit' THEN a.creditLimit ELSE t.amount END) AS mixed ` +
      `FROM "Transaction" t JOIN Account a ON t.accountId = a.id`
    expect(moneyUnitsPlan(sql)).toEqual({ kind: 'refuse' })
  })

  it('an unresolved qualified star (typo\'d or unknown alias) refuses', () => {
    const sql = `SELECT z.* FROM "Transaction" t`
    expect(moneyUnitsPlan(sql)).toEqual({ kind: 'refuse' })
  })
})

describe('moneyUnitsPlan — defensive coverage of the balance-scope-banned columns', () => {
  // These can never actually reach this classifier in the running route —
  // balanceScopeViolation/balanceScopeRowViolation already refuse a query that
  // references either column, upstream. Included so the classifier's own
  // schema table stays complete and consistent with ADR-0020's text.
  it('openingBalance and lastReconciledBalance are recognised as money columns', () => {
    expect(moneyUnitsPlan(`SELECT openingBalance FROM Account`))
      .toEqual({ kind: 'ok', convertKeys: ['openingBalance'] })
    expect(moneyUnitsPlan(`SELECT lastReconciledBalance FROM Account`))
      .toEqual({ kind: 'ok', convertKeys: ['lastReconciledBalance'] })
  })
})

describe('applyMoneyUnits', () => {
  it('divides only the planned keys, leaving everything else untouched', () => {
    const plan = moneyUnitsPlan(`SELECT date, amount FROM "Transaction"`)
    const rows = [{ date: '2026-01-01', amount: -1234 }, { date: '2026-01-02', amount: 500 }]
    expect(applyMoneyUnits(rows, plan)).toEqual([
      { date: '2026-01-01', amount: -12.34 },
      { date: '2026-01-02', amount: 5 },
    ])
  })

  it('a NULL aggregate stays NULL, it does not become 0', () => {
    const plan = moneyUnitsPlan(`SELECT SUM(amount) AS total FROM "Transaction" WHERE 1 = 0`)
    expect(applyMoneyUnits([{ total: null }], plan)).toEqual([{ total: null }])
  })

  it('a refuse-kind plan is a no-op — the route never calls this on a refused query, but stay inert', () => {
    expect(applyMoneyUnits([{ amount: -100 }], { kind: 'refuse' })).toEqual([{ amount: -100 }])
  })

  it('does not mutate the input row objects', () => {
    const plan = moneyUnitsPlan(`SELECT amount FROM "Transaction"`)
    const rows = [{ amount: -1000 }]
    const out = applyMoneyUnits(rows, plan)
    expect(rows).toEqual([{ amount: -1000 }])
    expect(out).toEqual([{ amount: -10 }])
  })
})
