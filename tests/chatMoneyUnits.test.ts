import { describe, expect, it } from 'vitest'
import { applyMoneySign, applyMoneyUnits, moneyUnitsPlan } from '@/lib/chatMoneyUnits'

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
    expect(moneyUnitsPlan(sql)).toMatchObject({ kind: 'ok', convertKeys: ['amount'] })
  })

  it('a qualified row-level amount column converts under its own name', () => {
    const sql = `SELECT t.date, t.amount FROM "Transaction" t JOIN Account a ON t.accountId = a.id`
    expect(moneyUnitsPlan(sql)).toMatchObject({ kind: 'ok', convertKeys: ['amount'] })
  })

  it('SELECT * over a single known table converts its money sub-columns', () => {
    expect(moneyUnitsPlan(`SELECT * FROM "Transaction" WHERE parentTransactionId IS NULL LIMIT 5`))
      .toMatchObject({ kind: 'ok', convertKeys: ['amount'] })
    expect(moneyUnitsPlan(`SELECT * FROM Account`)).toMatchObject({
      kind: 'ok',
      convertKeys: ['creditLimit', 'openingBalance', 'lastReconciledBalance'],
    })
  })

  it('a qualified star over a multi-table join resolves to its own table, not ambiguous', () => {
    const sql = `SELECT t.* FROM "Transaction" t JOIN Account a ON t.accountId = a.id`
    expect(moneyUnitsPlan(sql)).toMatchObject({ kind: 'ok', convertKeys: ['amount'] })
  })

  it('Account.creditLimit converts', () => {
    const sql = `SELECT name, creditLimit FROM Account WHERE accountType = 'credit'`
    expect(moneyUnitsPlan(sql)).toMatchObject({ kind: 'ok', convertKeys: ['creditLimit'] })
  })

  it('a bare negated amount converts under its own alias', () => {
    const sql = `SELECT -amount AS spent FROM "Transaction" WHERE amount < 0 LIMIT 1`
    expect(moneyUnitsPlan(sql)).toMatchObject({ kind: 'ok', convertKeys: ['spent'] })
  })

  it('SUM(amount) with no /100.0 converts as a safety net for a forgotten conversion', () => {
    const sql = `SELECT SUM(amount) AS total FROM "Transaction"`
    expect(moneyUnitsPlan(sql)).toMatchObject({ kind: 'ok', convertKeys: ['total'] })
  })

  it('a CASE aggregate whose branches all resolve to the same money column converts', () => {
    const sql = `SELECT SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS total_expenses FROM "Transaction"`
    expect(moneyUnitsPlan(sql)).toMatchObject({ kind: 'ok', convertKeys: ['total_expenses'] })
  })
})

describe('moneyUnitsPlan — already-converted shapes are left untouched', () => {
  it('SUM(amount) / 100.0 is not double-divided', () => {
    const sql = `SELECT SUM(amount) / 100.0 AS total FROM "Transaction"`
    expect(moneyUnitsPlan(sql)).toMatchObject({ kind: 'ok', convertKeys: [] })
  })

  it('the shipped two-figure worked example (both branches carry /100.0) is left alone', () => {
    const sql =
      `SELECT SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) / 100.0 AS total_expenses, ` +
      `SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) / 100.0 AS total_income FROM "Transaction"`
    expect(moneyUnitsPlan(sql)).toMatchObject({ kind: 'ok', convertKeys: [] })
  })

  it('the shipped account-join worked example (qualified column, /100.0, multi-table JOIN) is left alone', () => {
    const sql =
      `SELECT SUM(-t.amount) / 100.0 AS total_spent FROM "Transaction" t JOIN Account a ON t.accountId = a.id ` +
      `WHERE a.name = 'ADCB Credit Card'`
    expect(moneyUnitsPlan(sql)).toMatchObject({ kind: 'ok', convertKeys: [] })
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
    expect(moneyUnitsPlan(sql)).toMatchObject({ kind: 'ok', convertKeys: [] })
  })
})

describe('moneyUnitsPlan — not money, left untouched regardless of complexity', () => {
  it('COUNT(...) is never money, even COUNT(amount)', () => {
    expect(moneyUnitsPlan(`SELECT COUNT(amount) AS n FROM "Transaction"`))
      .toMatchObject({ kind: 'ok', convertKeys: [] })
    expect(moneyUnitsPlan(`SELECT COUNT(*) AS n FROM "Transaction"`))
      .toMatchObject({ kind: 'ok', convertKeys: [] })
  })

  it('a projection referencing no money column is left alone, however complex', () => {
    const sql = `SELECT category, strftime('%Y-%m', date) AS ym, COUNT(*) AS n FROM "Transaction" GROUP BY category, ym`
    expect(moneyUnitsPlan(sql)).toMatchObject({ kind: 'ok', convertKeys: [] })
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
      .toMatchObject({ kind: 'ok', convertKeys: ['openingBalance'] })
    expect(moneyUnitsPlan(`SELECT lastReconciledBalance FROM Account`))
      .toMatchObject({ kind: 'ok', convertKeys: ['lastReconciledBalance'] })
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

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0027: display sign is decided server-side, per money column, from the
// direction restriction the query already made.
//
// `moneyKeys` is the corrected money-column set the `result` frame classifies
// from — `convertKeys` undercounted it, missing every already-/100-divided
// projection, which is all nine of the SQL prompt's worked examples.
//
// `magnitudeKeys` ⊆ `moneyKeys` is opt-in from an explicit trigger: the
// projection negates its money column, or the top-level WHERE pins that
// column's direction. Everything else stays signed, which is what keeps a
// future signed answer (net savings, cash flow) unbroken and a mixed
// transaction list's per-row direction visible.
// ─────────────────────────────────────────────────────────────────────────────

/** `moneyUnitsPlan` narrowed to 'ok' — every SQL below is a resolvable shape. */
function okPlan(sql: string): { convertKeys: string[]; moneyKeys: string[]; magnitudeKeys: string[] } {
  const plan = moneyUnitsPlan(sql)
  if (plan.kind !== 'ok') throw new Error(`expected an ok plan for: ${sql}`)
  return plan
}

describe('moneyUnitsPlan — moneyKeys (ADR-0027)', () => {
  it('a plain /100 total is money even though nothing needed converting', () => {
    const sql =
      `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" ` +
      `WHERE category = '🛒 Groceries' AND strftime('%Y-%m', date) = '2026-07'`
    const plan = okPlan(sql)
    expect(plan.convertKeys).toEqual([])   // the bug: ADR-0023 classified off this
    expect(plan.moneyKeys).toEqual(['total'])
    // No negation and no direction filter, so nothing pins the sign.
    expect(plan.magnitudeKeys).toEqual([])
  })

  it('an unconverted money column is money too — moneyKeys is a superset of convertKeys', () => {
    const plan = okPlan(`SELECT SUM(amount) AS total FROM "Transaction"`)
    expect(plan.convertKeys).toEqual(['total'])
    expect(plan.moneyKeys).toEqual(['total'])
  })

  it('a derived ratio that merely mentions amount is NOT money', () => {
    // Stricter than reusing `containsMoneyColumn`: a percentage is not a
    // currency figure, and a currency symbol on it would be a new wrong answer.
    const sql =
      `SELECT SUM(CASE WHEN category = '🛒 Groceries' THEN -amount ELSE 0 END) / 100.0 / ` +
      `SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS pct FROM "Transaction" WHERE amount < 0`
    const plan = okPlan(sql)
    expect(plan.moneyKeys).toEqual([])
    expect(plan.magnitudeKeys).toEqual([])
  })

  it('a count column beside a money column is not money', () => {
    const sql = `SELECT category, SUM(amount) / 100.0 AS total, COUNT(*) AS n FROM "Transaction" GROUP BY category`
    expect(okPlan(sql).moneyKeys).toEqual(['total'])
  })

  it('star-expanded money columns are money', () => {
    expect(okPlan(`SELECT * FROM "Transaction" LIMIT 5`).moneyKeys).toEqual(['amount'])
  })
})

describe('moneyUnitsPlan — magnitudeKeys via projection negation (ADR-0027)', () => {
  it('SUM(-amount) is a magnitude', () => {
    const sql = `SELECT SUM(-amount) / 100.0 AS total_spent FROM "Transaction" WHERE category = '🛒 Groceries'`
    const plan = okPlan(sql)
    expect(plan.moneyKeys).toEqual(['total_spent'])
    expect(plan.magnitudeKeys).toEqual(['total_spent'])
  })

  it('a qualified SUM(-t.amount) is a magnitude', () => {
    const sql =
      `SELECT SUM(-t.amount) / 100.0 AS total_spent FROM "Transaction" t ` +
      `JOIN Account a ON t.accountId = a.id WHERE a.name = 'ADCB Current'`
    expect(okPlan(sql).magnitudeKeys).toEqual(['total_spent'])
  })

  it('a bare -amount row column is a magnitude', () => {
    const sql = `SELECT -amount AS spent FROM "Transaction" LIMIT 5`
    expect(okPlan(sql).magnitudeKeys).toEqual(['spent'])
  })

  it('a CASE whose value branches are -amount and a literal is a magnitude', () => {
    const sql =
      `SELECT SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) / 100.0 AS total_expenses ` +
      `FROM "Transaction" WHERE transactionType != 'transfer'`
    expect(okPlan(sql).magnitudeKeys).toEqual(['total_expenses'])
  })

  it('a CASE with an un-negated value branch is not a magnitude by negation', () => {
    // The inflow half of the income/expense pair: SUM(CASE WHEN amount > 0 THEN
    // amount ELSE 0 END) is already positive, and nothing here pins it.
    const sql =
      `SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) / 100.0 AS total_income ` +
      `FROM "Transaction" WHERE transactionType != 'transfer'`
    const plan = okPlan(sql)
    expect(plan.moneyKeys).toEqual(['total_income'])
    expect(plan.magnitudeKeys).toEqual([])
  })

  it('the two halves of an income/expense pair are classified independently', () => {
    const sql =
      `SELECT SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) / 100.0 AS total_expenses, ` +
      `SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) / 100.0 AS total_income FROM "Transaction"`
    const plan = okPlan(sql)
    expect(plan.moneyKeys).toEqual(['total_expenses', 'total_income'])
    expect(plan.magnitudeKeys).toEqual(['total_expenses'])
  })
})

describe('moneyUnitsPlan — magnitudeKeys via a WHERE direction pin (ADR-0027)', () => {
  it('WHERE amount < 0 makes a bare SUM(amount) total a magnitude', () => {
    // This is the convergence ADR-0027 is after: the same question answered
    // with SUM(-amount) or with SUM(amount) over an amount < 0 filter now
    // displays identically, whichever alias the model happened to write.
    const sql = `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE amount < 0 AND category = '🛒 Groceries'`
    const plan = okPlan(sql)
    expect(plan.moneyKeys).toEqual(['total'])
    expect(plan.magnitudeKeys).toEqual(['total'])
  })

  it('every zero comparison pins a direction: <=, >, >=', () => {
    for (const op of ['<=', '>', '>=']) {
      const sql = `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE amount ${op} 0`
      expect(okPlan(sql).magnitudeKeys).toEqual(['total'])
    }
  })

  it('a qualified pin resolves through the table alias', () => {
    const sql =
      `SELECT SUM(t.amount) / 100.0 AS total FROM "Transaction" t ` +
      `JOIN Account a ON t.accountId = a.id WHERE t.amount < 0`
    expect(okPlan(sql).magnitudeKeys).toEqual(['total'])
  })

  it('a pin inside a subquery does not count — it restricts the subquery, not these rows', () => {
    const sql =
      `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" ` +
      `WHERE NOT EXISTS (SELECT 1 FROM "Transaction" x WHERE x.amount < 0)`
    expect(okPlan(sql).magnitudeKeys).toEqual([])
  })

  it('a pin after the WHERE clause ends (a HAVING) does not count', () => {
    const sql =
      `SELECT category, SUM(amount) / 100.0 AS total FROM "Transaction" ` +
      `GROUP BY category HAVING SUM(amount) < 0`
    expect(okPlan(sql).magnitudeKeys).toEqual([])
  })

  it('a comparison against something other than zero pins nothing', () => {
    const sql = `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE amount < -5000`
    expect(okPlan(sql).magnitudeKeys).toEqual([])
  })

  it('a star over a direction-pinned list is a magnitude; an unfiltered one is not', () => {
    expect(okPlan(`SELECT * FROM "Transaction" WHERE amount < 0 LIMIT 5`).magnitudeKeys).toEqual(['amount'])
    expect(okPlan(`SELECT * FROM "Transaction" LIMIT 5`).magnitudeKeys).toEqual([])
  })
})

describe('moneyUnitsPlan — what deliberately stays signed (ADR-0027)', () => {
  it('a bare SUM(amount) AS net with no direction filter stays signed', () => {
    // The deferred signed-answer case (net savings, cash flow). It needs no
    // special handling precisely because it never enters magnitudeKeys.
    const sql = `SELECT SUM(amount) / 100.0 AS net FROM "Transaction" WHERE strftime('%Y', date) = '2026'`
    const plan = okPlan(sql)
    expect(plan.moneyKeys).toEqual(['net'])
    expect(plan.magnitudeKeys).toEqual([])
  })

  it('a mixed transaction list keeps its per-row signs — there the sign IS the direction', () => {
    const sql = `SELECT date, description, amount / 100.0 AS amount FROM "Transaction" ORDER BY date DESC LIMIT 20`
    const plan = okPlan(sql)
    expect(plan.moneyKeys).toEqual(['amount'])
    expect(plan.magnitudeKeys).toEqual([])
  })

  it('a refused plan carries no display fields at all', () => {
    expect(moneyUnitsPlan(`WITH x AS (SELECT 1) SELECT * FROM x`)).toEqual({ kind: 'refuse' })
  })
})

describe('applyMoneySign', () => {
  it('takes the absolute value of exactly the magnitude keys', () => {
    const plan = moneyUnitsPlan(
      `SELECT SUM(-amount) / 100.0 AS total_spent, SUM(amount) / 100.0 AS net FROM "Transaction"`,
    )
    expect(applyMoneySign([{ total_spent: -3654.43, net: -120.5 }], plan))
      .toEqual([{ total_spent: 3654.43, net: -120.5 }])
  })

  it('leaves an already-positive value alone', () => {
    const plan = moneyUnitsPlan(`SELECT SUM(-amount) / 100.0 AS total_spent FROM "Transaction"`)
    expect(applyMoneySign([{ total_spent: 3654.43 }], plan)).toEqual([{ total_spent: 3654.43 }])
  })

  it('a NULL passes through untouched — it does not become 0', () => {
    const plan = moneyUnitsPlan(`SELECT SUM(-amount) / 100.0 AS total_spent FROM "Transaction" WHERE 1 = 0`)
    expect(applyMoneySign([{ total_spent: null }], plan)).toEqual([{ total_spent: null }])
  })

  it('a non-numeric or absent value passes through untouched', () => {
    const plan = moneyUnitsPlan(`SELECT SUM(-amount) / 100.0 AS total_spent FROM "Transaction"`)
    expect(applyMoneySign([{ total_spent: 'n/a' }, { other: 1 }], plan))
      .toEqual([{ total_spent: 'n/a' }, { other: 1 }])
  })

  it('a refuse-kind plan is a no-op', () => {
    expect(applyMoneySign([{ amount: -100 }], { kind: 'refuse' })).toEqual([{ amount: -100 }])
  })

  it('does not mutate the input row objects', () => {
    const plan = moneyUnitsPlan(`SELECT SUM(-amount) / 100.0 AS total_spent FROM "Transaction"`)
    const rows = [{ total_spent: -10 }]
    const out = applyMoneySign(rows, plan)
    expect(rows).toEqual([{ total_spent: -10 }])
    expect(out).toEqual([{ total_spent: 10 }])
  })
})
