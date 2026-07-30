import { describe, expect, it } from 'vitest'
import { compoundSelectMessage, compoundSelectViolation } from '@/lib/chatCompoundSelect'

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0011: chat-generated SQL may not use UNION or UNION ALL. SQLite names a
// compound result set after its first branch only, so a two-branch query
// silently relabels the second branch's figures as the first's.
//
// Unit coverage of the detector. Route-level coverage (both SQL passes, the
// short-circuit, the non-answer frame) lives in tests/chatCompoundSelectRoute.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

/** Session 11's query shape, verbatim in structure — ADR-0011's named fixture. */
const SESSION_11_SQL =
  `SELECT SUM(amount) / 100.0 AS total_expenses FROM "Transaction" ` +
  `WHERE amount < 0 AND strftime('%Y-%m', date) = '2026-06' ` +
  `UNION ALL ` +
  `SELECT SUM(amount) / 100.0 AS total_income FROM "Transaction" ` +
  `WHERE amount > 0 AND strftime('%Y-%m', date) = '2026-06'`

describe('compoundSelectViolation', () => {
  it('(a) flags UNION ALL — session 11', () => {
    expect(compoundSelectViolation(SESSION_11_SQL)).toEqual({ keyword: 'UNION ALL' })
  })

  it('(b) flags a bare UNION', () => {
    const sql =
      `SELECT category FROM "Transaction" WHERE amount < 0 ` +
      `UNION SELECT category FROM "Transaction" WHERE amount > 0 LIMIT 200`
    expect(compoundSelectViolation(sql)).toEqual({ keyword: 'UNION' })
  })

  it('(c) is case-insensitive and normalises the reported keyword', () => {
    expect(compoundSelectViolation('SELECT 1 union all SELECT 2')).toEqual({ keyword: 'UNION ALL' })
    expect(compoundSelectViolation('SELECT 1 Union SELECT 2')).toEqual({ keyword: 'UNION' })
    expect(compoundSelectViolation('SELECT 1 uNiOn AlL SELECT 2')).toEqual({ keyword: 'UNION ALL' })
  })

  it('collapses odd whitespace between UNION and ALL, including a newline', () => {
    expect(compoundSelectViolation('SELECT 1\nUNION\n  ALL\nSELECT 2')).toEqual({ keyword: 'UNION ALL' })
  })

  it('(d) does not fire on "union" as a substring of an identifier', () => {
    // A naive substring match rejects all of these. None is a compound select.
    for (const sql of [
      `SELECT SUM(union_dues) / 100.0 AS total FROM "Transaction" LIMIT 200`,
      `SELECT COUNT(*) AS total FROM "Transaction" WHERE description LIKE '%reunion%' LIMIT 200`,
      `SELECT unionized AS total FROM "Transaction" LIMIT 200`,
      `SELECT SUM(amount) AS union_total FROM "Transaction" LIMIT 200`,
    ]) {
      expect(compoundSelectViolation(sql), sql).toBeNull()
    }
  })

  it('(d) does not fire on the whole word "union" inside a string literal', () => {
    // A stored category or payee can legitimately be called this. The check
    // reads SQL structure, and a quoted literal is data, not structure.
    const sql =
      `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" ` +
      `WHERE category = '🍽️ Union Square Diner' AND status IN ('committed','reconciled') LIMIT 200`
    expect(compoundSelectViolation(sql)).toBeNull()
  })

  it('handles a doubled-quote escape inside a literal without losing its place', () => {
    const sql =
      `SELECT SUM(amount) AS total FROM "Transaction" WHERE description = 'Bob''s Union Cafe' LIMIT 200`
    expect(compoundSelectViolation(sql)).toBeNull()
  })

  it('still catches a UNION that follows a literal containing the word', () => {
    const sql =
      `SELECT 1 AS a FROM "Transaction" WHERE category = 'Union Dues' ` +
      `UNION ALL SELECT 2 AS b FROM "Transaction"`
    expect(compoundSelectViolation(sql)).toEqual({ keyword: 'UNION ALL' })
  })

  it('falls back to the raw text when quoting is unbalanced', () => {
    // Malformed model output: one stray delimiter would otherwise swallow the
    // rest of the statement and hide the operator. Over-rejecting is the safe
    // direction; under-detecting is the bug this file exists to stop.
    const sql = `SELECT 1 WHERE x = 'oops UNION ALL SELECT 2`
    expect(compoundSelectViolation(sql)).toEqual({ keyword: 'UNION ALL' })
  })

  it('(g) passes the conditional-aggregate shape the prompt now teaches', () => {
    const sql =
      `SELECT SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) / 100.0 AS total_expenses, ` +
      `SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) / 100.0 AS total_income ` +
      `FROM "Transaction" WHERE status IN ('committed','reconciled') LIMIT 200`
    expect(compoundSelectViolation(sql)).toBeNull()
  })

  it('passes ordinary queries, including a WITH ... SELECT', () => {
    for (const sql of [
      `SELECT COUNT(*) AS total FROM "Transaction"`,
      `WITH m AS (SELECT strftime('%Y-%m', date) AS ym, SUM(amount) AS net FROM "Transaction" GROUP BY ym) ` +
        `SELECT ym, net / 100.0 AS total FROM m ORDER BY ym LIMIT 200`,
      `SELECT a.name, SUM(t.amount) / 100.0 AS total FROM "Transaction" t JOIN Account a ON t.accountId = a.id GROUP BY a.name LIMIT 200`,
    ]) {
      expect(compoundSelectViolation(sql), sql).toBeNull()
    }
  })

  it('does not read the user question — only generated SQL is ever passed in', () => {
    // ADR-0011 § Consequences: a question whose text contains "union" is
    // unaffected. Documented here because the guarantee is about the call site.
    const sql = `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" LIMIT 200`
    expect(compoundSelectViolation(sql)).toBeNull()
  })
})

describe('compoundSelectMessage', () => {
  const message = compoundSelectMessage({ keyword: 'UNION ALL' })

  it('names the shape problem in ADR-0011’s own wording', () => {
    expect(message).toContain("I couldn't build a single clear result for that")
    expect(message).toMatch(/one figure at a time/i)
  })

  it('explains the first-branch naming rule that caused the wrong answer', () => {
    expect(message).toMatch(/first\s+branch/i)
    expect(message).toContain('UNION ALL')
  })

  it('offers the shape that does work', () => {
    expect(message).toMatch(/its own column/i)
  })

  it('is not a bare error string', () => {
    expect(message.length).toBeGreaterThan(120)
    expect(message).not.toMatch(/rejected|invalid|error/i)
  })
})
