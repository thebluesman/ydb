import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as Db } from 'better-sqlite3'
import { buildSqlSystemPrompt } from '@/lib/chatSqlPrompt'

// ─────────────────────────────────────────────────────────────────────────────
// Transfer VOLUME is not SUM(amount) over transfer rows.
//
// Session (2026-07-30), follow-up to the income/expense transfer-exclusion fix:
// "How much did I move between my accounts this year?". The model produced
//
//   SELECT SUM(amount) / 100.0 AS total FROM "Transaction"
//   WHERE transactionType = 'transfer' AND strftime('%Y', date) = strftime('%Y', date('now')) ...
//
// which is structurally broken rather than merely wrong on one dataset. A
// transfer is stored as a matched pair — one negative leg on the source account,
// one positive leg on the destination — so SUM(amount) over transfer rows
// cancels to (approximately) zero for ANY ledger, however much money moved. The
// answer looks like a confident, well-formed zero.
//
// This is the mirror of the exclusion case in chatTransferExclusion.test.ts:
// there transfers had to be kept out of income and spending; here they are the
// entire subject, and the fix is to sum only the inflow legs, which counts each
// transfer exactly once at its true size.
//
// Prompt-only fix, same category as the split-leg, reimbursement and
// transfer-exclusion guards: a stated rule plus a worked example. No ADR and no
// route-level detector — the correction is arithmetic, not a judgement call.
//
// Fixture figures below are synthetic and chosen to make the failure visible;
// they are not drawn from any real ledger.
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date('2026-07-30T09:00:00.000Z')

describe('transfer-volume rule in the SQL prompt', () => {
  const prompt = buildSqlSystemPrompt(NOW)

  it('states that a bare sum over transfer rows cannot compute the volume moved', () => {
    expect(prompt).toMatch(/CANNOT compute it/)
    expect(prompt).toMatch(/equal and opposite/i)
  })

  it('explains why, not just what to type: the legs cancel regardless of volume', () => {
    expect(prompt).toMatch(/no matter how much money actually moved/i)
    expect(prompt).toMatch(/artefact of how a transfer is stored/i)
  })

  it('prescribes the inflow-leg shape', () => {
    expect(prompt).toContain('SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)')
    expect(prompt).toMatch(/SUM\(ABS\(amount\)\) \/ 2/)
  })

  it("carries Shyam's phrasing as a worked example, with relative dates", () => {
    expect(prompt).toContain('Q: How much did I move between my accounts this year?')
    const line = answerFor(prompt, 'Q: How much did I move between my accounts this year?')
    expect(line).toContain("strftime('%Y', date) = strftime('%Y', date('now'))")
    expect(line).not.toMatch(/'20\d\d(-\d\d)?'/)
  })

  it('never demonstrates a bare SUM(amount) scoped to transfers', () => {
    // Few-shot shape beats prose, so an example carrying the broken shape would
    // re-teach the bug the rule above exists to stop.
    const answerLines = prompt.split('\n').filter((l) => l.startsWith('A: '))
    const transferScoped = answerLines.filter((l) => /transactionType\s*=\s*'transfer'/.test(l))
    expect(transferScoped).not.toHaveLength(0)

    for (const line of transferScoped) {
      expect(line, line).not.toMatch(/SUM\(\s*amount\s*\)/i)
      expect(line, line).toContain('SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)')
    }
  })
})

/** The `A:` line following a given `Q:` line in the live prompt. */
function answerFor(prompt: string, question: string): string {
  const lines = prompt.split('\n')
  const qIndex = lines.findIndex((l) => l.startsWith(question))
  expect(qIndex).toBeGreaterThan(-1)
  return lines[qIndex + 1].replace(/^A: /, '')
}

describe("the few-shot's own SQL, executed against matched transfer pairs", () => {
  let db: Db

  const fewShotSql = answerFor(
    buildSqlSystemPrompt(NOW),
    'Q: How much did I move between my accounts this year?'
  )

  // Dated to date('now')'s year, since the few-shot filters relatively and
  // SQLite resolves that at execution time.
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
      linkedTransferId INTEGER
    )`)

    const insert = db.prepare(
      `INSERT INTO "Transaction" (id, date, amount, transactionType, category, accountId, status, linkedTransferId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const rows: Array<[number, string, number, string, string, number, string, number | null]> = [
      // Three matched transfer pairs this year: 1,500.00 + 400.00 + 25.50,
      // so the true volume moved is 1,925.50.
      [1, `${thisYear}-02-01 00:00:00.000`, -150_000, 'transfer', 'Transfer', 1, 'committed', 2],
      [2, `${thisYear}-02-01 00:00:00.000`, 150_000, 'transfer', 'Transfer', 2, 'committed', 1],
      [3, `${thisYear}-03-15 00:00:00.000`, -40_000, 'transfer', 'Transfer', 2, 'reconciled', 4],
      [4, `${thisYear}-03-15 00:00:00.000`, 40_000, 'transfer', 'Transfer', 1, 'reconciled', 3],
      // A deliberately small pair: the volume must not be dominated by one leg.
      [5, `${thisYear}-04-02 00:00:00.000`, -2_550, 'transfer', 'Transfer', 1, 'committed', 6],
      [6, `${thisYear}-04-02 00:00:00.000`, 2_550, 'transfer', 'Transfer', 3, 'committed', 5],
      // Non-transfer rows this year, which must not reach the figure at all.
      [7, `${thisYear}-02-05 00:00:00.000`, 88_000, 'credit', 'Salary', 1, 'committed', null],
      [8, `${thisYear}-02-06 00:00:00.000`, -13_000, 'debit', 'Groceries', 1, 'reconciled', null],
      // Out of scope: last year's pair, and an unreviewed pair this year.
      [9, `${lastYear}-11-01 00:00:00.000`, -500_000, 'transfer', 'Transfer', 1, 'committed', 10],
      [10, `${lastYear}-11-01 00:00:00.000`, 500_000, 'transfer', 'Transfer', 2, 'committed', 9],
      [11, `${thisYear}-05-09 00:00:00.000`, -60_000, 'transfer', 'Transfer', 1, 'review', 12],
      [12, `${thisYear}-05-09 00:00:00.000`, 60_000, 'transfer', 'Transfer', 2, 'review', 11],
    ]
    for (const r of rows) insert.run(...r)
  })

  afterAll(() => db.close())

  it('returns the true volume moved', () => {
    const row = db.prepare(fewShotSql).get() as { total: number }
    expect(row.total).toBe(1_925.5)
  })

  it('agrees with SUM(ABS(amount)) / 2, the equivalence the rule claims', () => {
    const row = db
      .prepare(
        `SELECT SUM(ABS(amount)) / 2 / 100.0 AS total FROM "Transaction"
         WHERE transactionType = 'transfer' AND strftime('%Y', date) = strftime('%Y', date('now'))
           AND status IN ('committed','reconciled')`
      )
      .get() as { total: number }
    expect(row.total).toBe(1_925.5)
  })

  it('reproduces the bug with the naive shape, so the example is what does the work', () => {
    // The exact SQL from the session: same filters, bare SUM(amount).
    const naive = fewShotSql.replace(
      'SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)',
      'SUM(amount)'
    )
    expect(naive).toContain('SUM(amount)')

    const row = db.prepare(naive).get() as { total: number }
    // Zero despite three real transfers in scope — the legs cancel by
    // construction, which is why the shape is broken for every ledger and not
    // just this fixture.
    expect(row.total).toBe(0)
  })

  it('cancels to zero for any pairing, not just these amounts', () => {
    // Same claim stated independently of the fixture's figures: within the
    // scoped rows, inflow legs and outflow legs are equal, so their sum is 0.
    const row = db
      .prepare(
        `SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS inflow,
                SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS outflow
         FROM "Transaction" WHERE transactionType = 'transfer'`
      )
      .get() as { inflow: number; outflow: number }
    expect(row.inflow).toBe(row.outflow)
    expect(row.inflow).toBeGreaterThan(0)
  })
})
