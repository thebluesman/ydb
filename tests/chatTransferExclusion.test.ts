import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as Db } from 'better-sqlite3'
import { buildSqlSystemPrompt } from '@/lib/chatSqlPrompt'

// ─────────────────────────────────────────────────────────────────────────────
// Transfers must not be counted as income or spending.
//
// Session (2026-07-30), "What's my total income and total expenses this year?".
// The model produced a correct single-row conditional aggregate — ADR-0011's
// fix held — but split purely on the sign of amount:
//
//   SUM(CASE WHEN amount > 0 ...) AS total_income,
//   SUM(CASE WHEN amount < 0 ...) AS total_expenses
//
// with no transactionType guard. A transfer between the user's own accounts is
// stored as two rows, one negative leg and one positive leg, so the sign split
// counted the outgoing leg as an expense and the incoming leg as income,
// inflating both totals by the same amount — a pair that nets to zero and
// belongs in neither figure.
//
// The fix is prompt-only, in the same category as the split-leg
// (parentTransactionId IS NULL) and reimbursement (reimbursementTxId IS NULL)
// guards: a stated rule plus worked examples that demonstrate the guard. There
// is no route-level detector here, unlike ADR-0008/0010/0011, because excluding
// transfers from income and spending is mechanical rather than a judgement call.
//
// These tests do two things: assert the prompt states the rule and never
// demonstrates an unguarded sign split, and execute the few-shot's own SQL
// against a fixture carrying transfer legs to prove the shape it teaches
// actually excludes them.
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date('2026-07-30T09:00:00.000Z')

describe('transfer-exclusion rule in the SQL prompt', () => {
  const prompt = buildSqlSystemPrompt(NOW)

  it('states that transfers are neither income nor spending', () => {
    expect(prompt).toMatch(/Transfers are NEITHER income NOR spending/)
    expect(prompt).toContain("transactionType != 'transfer'")
    expect(prompt).toContain("transactionType IN ('credit','debit')")
  })

  it('explains the mechanism: both legs counted, both totals inflated', () => {
    expect(prompt).toMatch(/inflating both totals by the same amount/i)
    expect(prompt).toMatch(/nets to zero/i)
  })

  it('ties the rule to sign-based filtering specifically', () => {
    expect(prompt).toMatch(/whenever the query filters or branches on the sign of amount/i)
  })

  it('carries the session question as a worked example', () => {
    expect(prompt).toContain("Q: What's my total income and total expenses this year?")
  })

  it('never demonstrates a sign split without the transfer guard', () => {
    // Few-shot shape beats prose instruction, so an example that splits on the
    // sign of amount and omits the guard would re-teach exactly the bug.
    const answerLines = prompt.split('\n').filter((l) => l.startsWith('A: '))
    expect(answerLines).not.toHaveLength(0)

    const signSplitLines = answerLines.filter((l) => /amount\s*[<>]\s*0/.test(l))
    expect(signSplitLines).not.toHaveLength(0)

    for (const line of signSplitLines) {
      expect(line, line).toMatch(/transactionType\s*(!=\s*'transfer'|IN\s*\('credit','debit'\))/)
    }
  })
})

describe("the few-shot's own SQL, executed against transfer legs", () => {
  let db: Db

  /** The `A:` answer for the question Shyam asked, lifted from the live prompt. */
  const fewShotSql = (() => {
    const lines = buildSqlSystemPrompt(NOW).split('\n')
    const qIndex = lines.findIndex((l) => l.startsWith("Q: What's my total income and total expenses this year?"))
    expect(qIndex).toBeGreaterThan(-1)
    return lines[qIndex + 1].replace(/^A: /, '')
  })()

  // Fixture: a transfer pair whose legs are larger than either real figure, so
  // leakage cannot hide inside rounding. Dated to date('now')'s year, since the
  // few-shot filters relatively and SQLite resolves it at execution time.
  const thisYear = new Date().getUTCFullYear()
  const lastYear = thisYear - 1

  beforeAll(() => {
    db = new Database(':memory:')
    db.exec(`CREATE TABLE "Transaction" (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      amount INTEGER NOT NULL,
      transactionType TEXT NOT NULL,
      category TEXT NOT NULL,
      accountId INTEGER NOT NULL,
      status TEXT NOT NULL,
      parentTransactionId INTEGER,
      reimbursementTxId INTEGER
    )`)

    const insert = db.prepare(
      `INSERT INTO "Transaction" (id, date, amount, transactionType, category, accountId, status, parentTransactionId, reimbursementTxId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const rows: Array<[number, string, number, string, string, number, string, number | null, number | null]> = [
      // Real income: 500.00 + 250.00 = 750.00
      [1, `${thisYear}-02-01 00:00:00.000`, 50_000, 'credit', 'Salary', 1, 'committed', null, null],
      [2, `${thisYear}-03-01 00:00:00.000`, 25_000, 'credit', 'Salary', 1, 'reconciled', null, null],
      // Real expenses: 120.00 + 30.00 = 150.00
      [3, `${thisYear}-02-05 00:00:00.000`, -12_000, 'debit', 'Groceries', 1, 'committed', null, null],
      [4, `${thisYear}-03-07 00:00:00.000`, -3_000, 'debit', 'Groceries', 1, 'reconciled', null, null],
      // Transfer pair, 9,000.00 each way: dwarfs both real figures.
      [5, `${thisYear}-04-01 00:00:00.000`, -900_000, 'transfer', 'Transfer', 1, 'committed', null, null],
      [6, `${thisYear}-04-01 00:00:00.000`, 900_000, 'transfer', 'Transfer', 2, 'committed', null, null],
      // Second transfer pair, uneven dates but still this year.
      [7, `${thisYear}-05-11 00:00:00.000`, -40_000, 'transfer', 'Transfer', 2, 'reconciled', null, null],
      [8, `${thisYear}-05-12 00:00:00.000`, 40_000, 'transfer', 'Transfer', 1, 'reconciled', null, null],
      // Out of scope, must not reach either figure: last year, and a review row.
      [9, `${lastYear}-06-01 00:00:00.000`, 99_999, 'credit', 'Salary', 1, 'committed', null, null],
      [10, `${thisYear}-06-01 00:00:00.000`, -77_777, 'debit', 'Groceries', 1, 'review', null, null],
    ]
    for (const r of rows) insert.run(...r)
  })

  afterAll(() => db.close())

  it('returns the true income and expense figures, transfers excluded', () => {
    const row = db.prepare(fewShotSql).get() as { total_income: number; total_expenses: number }
    expect(row.total_income).toBe(750)
    expect(row.total_expenses).toBe(150)
  })

  it("reproduces the bug when the guard is dropped, so the guard is what's doing the work", () => {
    const unguarded = fewShotSql.replace(/transactionType != 'transfer' AND /, '')
    expect(unguarded).not.toContain('transactionType')

    const row = db.prepare(unguarded).get() as { total_income: number; total_expenses: number }
    // Both figures inflated by the same 9,400.00 of transfer legs — the exact
    // shape of the reported bug.
    expect(row.total_income).toBe(750 + 9_400)
    expect(row.total_expenses).toBe(150 + 9_400)
  })

  it("counts a transfer leg's sign, not its type, when unguarded — pairs net to zero overall", () => {
    const legs = db
      .prepare(`SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS inflow, SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS outflow FROM "Transaction" WHERE transactionType = 'transfer'`)
      .get() as { inflow: number; outflow: number }
    expect(legs.inflow).toBe(legs.outflow)
  })
})
