import { describe, expect, it } from 'vitest'
import { ReadonlyQueryError, executeReadonlyQuery } from '@/lib/prisma'

// ─────────────────────────────────────────────────────────────────────────────
// `lib/prisma.ts`'s FORBIDDEN_IDENTIFIERS guard — the read-only SQL guard on
// the chat/query path, a do-not-break invariant per AGENTS.md.
//
// [chat-bug] budget/setting alias false positive: the guard matched forbidden
// table names (setting, budget, chatmessage, ...) as bare word-boundary tokens
// anywhere in the SQL, with no distinction between a genuine table reference
// (`FROM Budget`, `budget.amount`) and a column alias the model chose
// (`SUM(amount) AS budget`). A query that never touched the Budget or Setting
// tables was rejected purely for naming its output column "budget" — a
// perfectly reasonable choice for "how much have I budgeted this month."
//
// Fix: alias targets introduced by `AS` are masked out before the identifier
// scan, in every quoting style ADR-0010's own alias detector recognises
// (bare, "double", `backtick`, [bracket], 'single'). What precedes `AS` is
// left untouched, so a real table reference is still caught even when IT is
// then given an alias (`FROM Budget AS b` still blocks on "Budget").
// ─────────────────────────────────────────────────────────────────────────────

function blocked(sql: string): string | null {
  try {
    executeReadonlyQuery(sql)
    return null
  } catch (e) {
    if (e instanceof ReadonlyQueryError) return e.message
    throw e
  }
}

describe('FORBIDDEN_IDENTIFIERS false positives on aggregate aliases', () => {
  it.each([
    ['bare alias named "budget"', `SELECT SUM(amount) AS budget FROM "Transaction"`],
    ['double-quoted alias named "budget"', `SELECT SUM(amount) AS "budget" FROM "Transaction"`],
    ['bare alias named "setting"', `SELECT category, SUM(amount) AS setting FROM "Transaction" GROUP BY category`],
    ['double-quoted multi-word alias', `SELECT SUM(amount) AS "monthly budget" FROM "Transaction"`],
    ['backtick-quoted alias', 'SELECT SUM(amount) AS `budget` FROM "Transaction"'],
    ['bracket-quoted alias', `SELECT SUM(amount) AS [budget] FROM "Transaction"`],
    ['single-quoted alias', `SELECT SUM(amount) AS 'budget' FROM "Transaction"`],
    ['a harmless table alias reusing the word', `SELECT b.amount FROM "Transaction" AS b`],
  ])('does not block: %s', (_label, sql) => {
    expect(blocked(sql)).toBeNull()
  })
})

describe('FORBIDDEN_IDENTIFIERS still blocks genuine access', () => {
  it.each([
    ['bare table reference', `SELECT * FROM Budget`],
    ['quoted table reference', `SELECT * FROM "Budget"`],
    ['aliased table reference (table name itself, not the alias target)', `SELECT b.amount FROM Budget b`],
    ['aliased with explicit AS', `SELECT b.amount FROM Budget AS b`],
    ['a different forbidden table', `SELECT * FROM "Setting"`],
    ['app-internal table', `SELECT * FROM ChatMessage`],
    ['ADR-0025/0026 verdict table', `SELECT * FROM ChatVerdict`],
    ['via a subquery, even with an innocuous outer alias', `SELECT (SELECT 1 FROM Budget) AS budget_status FROM "Transaction"`],
    ['sqlite schema introspection', `SELECT * FROM sqlite_master`],
  ])('blocks: %s', (_label, sql) => {
    expect(blocked(sql)).toMatch(/not allowed/)
  })
})

describe('unaffected control cases', () => {
  it('an ordinary grounded query still runs', () => {
    expect(blocked(`SELECT category, SUM(amount) AS total FROM "Transaction" GROUP BY category LIMIT 5`)).toBeNull()
  })

  it('an underscore-suffixed alias was never blocked and still is not', () => {
    // Word-boundary matching already handled this; not what the fix changed.
    expect(blocked(`SELECT SUM(amount) AS budget_remaining FROM "Transaction"`)).toBeNull()
  })

  it('a non-SELECT statement is still rejected outright', () => {
    expect(() => executeReadonlyQuery(`DELETE FROM "Transaction"`)).toThrow(ReadonlyQueryError)
  })
})
