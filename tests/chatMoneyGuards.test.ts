import { describe, expect, it } from 'vitest'
import {
  signBranchGuardMessage,
  signBranchGuardViolation,
  transferSumMessage,
  transferSumViolation,
} from '@/lib/chatMoneyGuards'

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0016: the two money guards whose applicability is decidable from the
// generated SQL alone move into route-level checks. Split-leg and reimbursement
// stay prompt-only, because whether they apply depends on what the question
// meant — those are covered by tests/chatSqlPromptGuardMatrix.test.ts instead.
//
// Unit coverage of the two detectors. Route-level coverage (both SQL passes, the
// short-circuit, the non-answer frame) lives in tests/chatMoneyGuardsRoute.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

describe('signBranchGuardViolation — a sign split with no transactionType predicate', () => {
  it('flags PR #32’s bug: income and expenses split by sign, transfers uncounted for', () => {
    // The live failure. Every transfer leg lands in one figure or the other, so
    // both come back too high by the amount moved, and the result looks fine.
    const sql =
      `SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) / 100.0 AS total_income, ` +
      `SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) / 100.0 AS total_expenses ` +
      `FROM "Transaction" WHERE status IN ('committed','reconciled')`
    expect(signBranchGuardViolation(sql)).toEqual({ branch: 'amount > 0' })
  })

  it('flags a WHERE-clause sign filter, not only a CASE branch', () => {
    const sql =
      `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" ` +
      `WHERE amount < 0 AND strftime('%Y-%m', date) = '2026-06'`
    expect(signBranchGuardViolation(sql)).toEqual({ branch: 'amount < 0' })
  })

  it('flags >= and <= — the zero row is not what makes the split wrong', () => {
    expect(signBranchGuardViolation('SELECT SUM(amount) AS t FROM "Transaction" WHERE amount >= 0'))
      .toEqual({ branch: 'amount >= 0' })
    expect(signBranchGuardViolation('SELECT SUM(amount) AS t FROM "Transaction" WHERE amount <= 0'))
      .toEqual({ branch: 'amount <= 0' })
  })

  it('flags a qualified column, in every quoting style SQLite accepts', () => {
    for (const col of ['t.amount', 'T1.amount', '"Transaction".amount', '[Transaction].amount']) {
      const sql = `SELECT SUM(${col}) AS total FROM "Transaction" t WHERE ${col} < 0`
      expect(signBranchGuardViolation(sql), col).not.toBeNull()
    }
  })

  it('flags the reversed comparison — a detector a reordering slips past is not one', () => {
    const sql = `SELECT COUNT(*) AS n FROM "Transaction" WHERE 0 < amount`
    expect(signBranchGuardViolation(sql)).toEqual({ branch: '0 < amount' })
  })

  it('normalises odd whitespace in the branch it reports, including a newline', () => {
    expect(signBranchGuardViolation('SELECT 1 FROM "Transaction" WHERE amount\n  <\n0'))
      .toEqual({ branch: 'amount < 0' })
  })

  it('passes once ANY transactionType predicate is present, whichever type it names', () => {
    // ADR-0016 § Decision, verbatim: "The check demands *some* transactionType
    // predicate, not a specific one". Anything narrower would be a judgement
    // about what the question meant.
    const branch = `SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) / 100.0 AS total`
    for (const pred of [
      `transactionType != 'transfer'`,
      `transactionType <> 'transfer'`,
      `transactionType = 'transfer'`,
      `transactionType IN ('credit','debit')`,
      `transactionType NOT IN ('transfer')`,
      `transactionType='credit'`,
      `T1.transactionType = 'credit'`,
    ]) {
      const sql = `SELECT ${branch} FROM "Transaction" T1 WHERE ${pred} AND status = 'committed'`
      expect(signBranchGuardViolation(sql), pred).toBeNull()
    }
  })

  it('passes the transfer-volume few-shot the prompt teaches (ADR-0016 § Consequences)', () => {
    // A sign branch over transfer-pinned rows — the CORRECT way to total volume.
    // If this ever starts failing, the guard has swallowed the shape it was
    // explicitly designed to let through.
    const sql =
      `SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) / 100.0 AS total FROM "Transaction" ` +
      `WHERE transactionType = 'transfer' AND strftime('%Y', date) = strftime('%Y', date('now')) ` +
      `AND status IN ('committed','reconciled')`
    expect(signBranchGuardViolation(sql)).toBeNull()
  })

  it('does NOT count a bare mention of transactionType as a guard', () => {
    // `GROUP BY transactionType` leaves every transfer leg in the aggregate. A
    // mention-based check would be satisfied while fixing nothing.
    const sql =
      `SELECT transactionType, SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS total ` +
      `FROM "Transaction" GROUP BY transactionType`
    expect(signBranchGuardViolation(sql)).not.toBeNull()

    // `IS NOT NULL` is true of every row, transfer legs included.
    const nullish = `SELECT SUM(amount) AS t FROM "Transaction" WHERE amount < 0 AND transactionType IS NOT NULL`
    expect(signBranchGuardViolation(nullish)).not.toBeNull()
  })

  it('passes a query with no sign branch at all', () => {
    // The category-filtered spend shape: no sign split, so the rule's own
    // trigger never fires. ADR-0016 logs the transfer-leg-with-a-spend-category
    // residual as an open ledger question, not something this detector guesses at.
    for (const sql of [
      `SELECT COUNT(*) AS n FROM "Transaction" WHERE parentTransactionId IS NULL`,
      `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE category = '🛒 Groceries'`,
      `SELECT SUM(-amount) / 100.0 AS total FROM "Transaction" WHERE amount != 0`,
      `SELECT COUNT(*) AS n FROM "Transaction" WHERE amount = 0`,
    ]) {
      expect(signBranchGuardViolation(sql), sql).toBeNull()
    }
  })

  it('does not read a sign branch out of a string literal', () => {
    const sql =
      `SELECT COUNT(*) AS n FROM "Transaction" ` +
      `WHERE description LIKE '%amount > 0%' AND category = 'amount < 0 refund'`
    expect(signBranchGuardViolation(sql)).toBeNull()
  })

  it('does not accept a transactionType predicate that only exists inside a literal', () => {
    // The mirror confusion: a literal must not be able to excuse a real branch.
    const sql =
      `SELECT SUM(amount) AS total FROM "Transaction" ` +
      `WHERE amount < 0 AND description = 'transactionType = transfer'`
    expect(signBranchGuardViolation(sql)).toEqual({ branch: 'amount < 0' })
  })

  it('handles a doubled-quote escape without losing its place', () => {
    const sql =
      `SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS total FROM "Transaction" ` +
      `WHERE description = 'Bob''s amount > 0 diner' AND transactionType != 'transfer'`
    expect(signBranchGuardViolation(sql)).toBeNull()
  })

  it('falls back to the raw text when quoting is unbalanced', () => {
    // Malformed model output: stripping would swallow the tail and hide the
    // branch. Over-rejecting is the safe direction on financial arithmetic.
    const sql = `SELECT SUM(amount) AS t FROM "Transaction" WHERE amount < 0 AND x = 'oops`
    expect(signBranchGuardViolation(sql)).toEqual({ branch: 'amount < 0' })
  })

  it('does not fire on "amount" as part of a longer identifier', () => {
    for (const sql of [
      `SELECT SUM(reimbursedAmount) AS total FROM "Transaction" WHERE reimbursedAmount > 0`,
      `SELECT SUM(amount_cents) AS total FROM "Transaction" WHERE amount_cents < 0`,
    ]) {
      expect(signBranchGuardViolation(sql), sql).toBeNull()
    }
  })
})

describe('transferSumViolation — a bare SUM(amount) over transfer-pinned rows', () => {
  it('flags PR #32’s other bug: transfer volume as SUM(amount)', () => {
    const sql =
      `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" ` +
      `WHERE transactionType = 'transfer' AND strftime('%Y', date) = strftime('%Y', date('now'))`
    expect(transferSumViolation(sql)).toEqual({ pin: `transactionType = 'transfer'` })
  })

  it('flags an IN list whose only member is transfer', () => {
    const sql = `SELECT SUM(amount) AS total FROM "Transaction" WHERE transactionType IN ('transfer')`
    expect(transferSumViolation(sql)).toEqual({ pin: `transactionType IN ('transfer')` })
  })

  it('flags SUM(-amount) — negating a pair that sums to zero still sums to zero', () => {
    const sql = `SELECT SUM(-amount) / 100.0 AS total FROM "Transaction" WHERE transactionType = 'transfer'`
    expect(transferSumViolation(sql)).not.toBeNull()
  })

  it('flags a qualified column', () => {
    const sql =
      `SELECT SUM(T1.amount) / 100.0 AS total FROM "Transaction" T1 ` +
      `WHERE T1.transactionType = 'transfer'`
    expect(transferSumViolation(sql)).not.toBeNull()
  })

  it('passes the conditional form, which is the correct way to total volume', () => {
    // Each transfer contributes exactly one positive leg, so this counts the
    // real amount moved, once. This is the prompt's own transfer-volume answer.
    const sql =
      `SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) / 100.0 AS total FROM "Transaction" ` +
      `WHERE transactionType = 'transfer' AND status IN ('committed','reconciled')`
    expect(transferSumViolation(sql)).toBeNull()
  })

  it('passes SUM(ABS(amount)) — double-counted, but not dead', () => {
    const sql = `SELECT SUM(ABS(amount)) / 200.0 AS total FROM "Transaction" WHERE transactionType = 'transfer'`
    expect(transferSumViolation(sql)).toBeNull()
  })

  it('passes when the rows are not pinned to transfers', () => {
    for (const pred of [
      `transactionType != 'transfer'`,
      `transactionType <> 'transfer'`,
      `transactionType NOT IN ('transfer')`,
      `transactionType IN ('transfer','credit')`,
      `transactionType = 'credit'`,
      `category = '🛒 Groceries'`,
    ]) {
      const sql = `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE ${pred}`
      expect(transferSumViolation(sql), pred).toBeNull()
    }
  })

  it('passes a query with no WHERE clause at all', () => {
    expect(transferSumViolation('SELECT SUM(amount) AS total FROM "Transaction"')).toBeNull()
  })

  it('does not read the pin out of a string literal', () => {
    const sql =
      `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" ` +
      `WHERE description = 'transactionType = ''transfer'''`
    expect(transferSumViolation(sql)).toBeNull()
  })

  it('does not read the pin out of a GROUP BY / ORDER BY tail', () => {
    // The pin has to be in the WHERE clause; grouping by type does not restrict
    // the rows, so the sum is over the whole ledger and does not cancel.
    const sql =
      `SELECT transactionType, SUM(amount) / 100.0 AS total FROM "Transaction" ` +
      `GROUP BY transactionType ORDER BY total DESC LIMIT 200`
    expect(transferSumViolation(sql)).toBeNull()
  })

  it('handles a doubled-quote escape and still sees a later real pin', () => {
    const sql =
      `SELECT SUM(amount) AS total FROM "Transaction" ` +
      `WHERE description != 'Bob''s' AND transactionType = 'transfer'`
    expect(transferSumViolation(sql)).toEqual({ pin: `transactionType = 'transfer'` })
  })

  it('still detects the pin when quoting is unbalanced', () => {
    const sql = `SELECT SUM(amount) AS total FROM "Transaction" WHERE transactionType = 'transfer' AND x = 'oops`
    expect(transferSumViolation(sql)).toEqual({ pin: `transactionType = 'transfer'` })
  })

  it('accepts SQLite’s == spelling', () => {
    const sql = `SELECT SUM(amount) AS total FROM "Transaction" WHERE transactionType == 'transfer'`
    expect(transferSumViolation(sql)).not.toBeNull()
  })
})

describe('the refusal copy', () => {
  const signMessage = signBranchGuardMessage({ branch: 'amount < 0' })
  const sumMessage = transferSumMessage({ pin: `transactionType = 'transfer'` })

  it('names the arithmetic problem, per ADR-0016’s explicit requirement', () => {
    // Not "your query was rejected" — what the number would have been and why.
    expect(signMessage).toMatch(/two rows|negative leg|incoming leg/i)
    expect(signMessage).toMatch(/too high/i)
    expect(sumMessage).toMatch(/equal and opposite/i)
    expect(sumMessage).toMatch(/cancels to zero|zero/i)
  })

  it('quotes back the specific construct it saw', () => {
    expect(signBranchGuardMessage({ branch: '0 < amount' })).toContain('0 < amount')
    expect(transferSumMessage({ pin: `transactionType IN ('transfer')` }))
      .toContain(`transactionType IN ('transfer')`)
  })

  it('says what will work instead — a refusal with no exit is a dead end (ADR-0014)', () => {
    expect(signMessage).toMatch(/exclude transfers/i)
    expect(sumMessage).toMatch(/incoming legs/i)
  })

  it('is not a bare error string', () => {
    for (const message of [signMessage, sumMessage]) {
      expect(message.length).toBeGreaterThan(120)
      expect(message).not.toMatch(/rejected|invalid|error/i)
    }
  })

  it('the two refusals do not read alike', () => {
    expect(signMessage).not.toBe(sumMessage)
  })
})
