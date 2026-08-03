import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as Db } from 'better-sqlite3'
import {
  buildSqlSystemPrompt,
  quarterLabel,
  quarterOf,
  quarterRange,
  shiftQuarters,
} from '@/lib/chatSqlPrompt'
import { moneyUnitsPlan } from '@/lib/chatMoneyUnits'
import { signBranchGuardViolation, transferSumViolation } from '@/lib/chatMoneyGuards'
import { balanceScopeViolation } from '@/lib/chatBalanceScope'
import { compoundSelectViolation } from '@/lib/chatCompoundSelect'

// ─────────────────────────────────────────────────────────────────────────────
// [chat-model] Tier 1, PR 4 — comparative (input 2), time-shifted (input 12) and
// cross-account/holistic (input 13) question shapes.
//
// Two things are tested here, and they are different things.
//
// 1. The quarter arithmetic, as pure functions. Same rationale as
//    `mostRecentMonthYm`: SQLite has no "start of quarter" modifier, so if the
//    server does not supply the boundaries the model either does month
//    arithmetic by hand or recalls a quarter from training data — the failure
//    `mostRecentMonthYm` exists to prevent, one granularity up.
//
// 2. The new worked examples, run through every guard the route would run them
//    through, and — for the comparative shape — actually EXECUTED against a
//    fixture. The second half matters because a comparative query has a failure
//    mode the guard matrix cannot see: pin the WHERE clause to one period and
//    the other column silently sums an empty set and reports a confident 0.00.
//    That is a correct-looking query returning a wrong number, which is the
//    category of bug this whole initiative keeps finding by hand. A test that
//    only asserted on prompt TEXT would pass against exactly that query.
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date('2026-07-31T09:00:00.000Z')
const CATEGORIES = ['🛒 Groceries', '✈️ Travel', '🚗 Auto loans', '🍽️ Dining']
const ACCOUNTS = ['ADCB Credit Card', 'ADCB, Current', 'Emirates NBD Savings']

describe('quarterOf', () => {
  it('maps each month to its quarter', () => {
    const q = (iso: string) => quarterOf(new Date(iso))
    expect(q('2026-01-01T00:00:00.000Z')).toEqual({ year: 2026, quarter: 1 })
    expect(q('2026-03-31T23:59:59.000Z')).toEqual({ year: 2026, quarter: 1 })
    expect(q('2026-04-01T00:00:00.000Z')).toEqual({ year: 2026, quarter: 2 })
    expect(q('2026-07-31T09:00:00.000Z')).toEqual({ year: 2026, quarter: 3 })
    expect(q('2026-10-01T00:00:00.000Z')).toEqual({ year: 2026, quarter: 4 })
    expect(q('2026-12-31T00:00:00.000Z')).toEqual({ year: 2026, quarter: 4 })
  })

  it('uses UTC, not the host timezone', () => {
    // 2026-10-01T00:30Z is still September 30 in any negative-offset zone. The
    // answer must follow UTC so it agrees with the rest of the date handling.
    expect(quarterOf(new Date('2026-10-01T00:30:00.000Z'))).toEqual({ year: 2026, quarter: 4 })
  })
})

describe('shiftQuarters', () => {
  it('moves forwards and backwards within a year', () => {
    expect(shiftQuarters({ year: 2026, quarter: 3 }, -1)).toEqual({ year: 2026, quarter: 2 })
    expect(shiftQuarters({ year: 2026, quarter: 1 }, 2)).toEqual({ year: 2026, quarter: 3 })
  })

  it('crosses the year boundary in both directions', () => {
    expect(shiftQuarters({ year: 2026, quarter: 1 }, -1)).toEqual({ year: 2025, quarter: 4 })
    expect(shiftQuarters({ year: 2026, quarter: 4 }, 1)).toEqual({ year: 2027, quarter: 1 })
    expect(shiftQuarters({ year: 2026, quarter: 2 }, -5)).toEqual({ year: 2025, quarter: 1 })
  })

  it('shifts a whole year with -4, for every quarter', () => {
    // The year-over-year case the prompt actually uses. Asserted for all four
    // quarters so a fixup that happens to work for Q3 cannot pass.
    for (const quarter of [1, 2, 3, 4]) {
      expect(shiftQuarters({ year: 2026, quarter }, -4)).toEqual({ year: 2025, quarter })
    }
  })

  it('is its own inverse', () => {
    for (const quarter of [1, 2, 3, 4]) {
      for (const delta of [-9, -4, -1, 0, 1, 7]) {
        const start = { year: 2026, quarter }
        expect(shiftQuarters(shiftQuarters(start, delta), -delta)).toEqual(start)
      }
    }
  })
})

describe('quarterRange', () => {
  it('returns half-open calendar boundaries', () => {
    expect(quarterRange({ year: 2026, quarter: 1 })).toEqual({ start: '2026-01-01', endExclusive: '2026-04-01' })
    expect(quarterRange({ year: 2026, quarter: 3 })).toEqual({ start: '2026-07-01', endExclusive: '2026-10-01' })
  })

  it('rolls Q4 into the following January', () => {
    expect(quarterRange({ year: 2026, quarter: 4 })).toEqual({ start: '2026-10-01', endExclusive: '2027-01-01' })
  })

  it('zero-pads single-digit months', () => {
    expect(quarterRange({ year: 2026, quarter: 1 }).start).toBe('2026-01-01')
    expect(quarterRange({ year: 2026, quarter: 2 }).start).toBe('2026-04-01')
  })

  it('ends each quarter exactly where the next begins, leaving no gap', () => {
    // The half-open contract. A gap here is a day of transactions belonging to
    // neither quarter; an overlap is a day counted in both.
    for (const quarter of [1, 2, 3, 4]) {
      const q = { year: 2026, quarter }
      expect(quarterRange(q).endExclusive).toBe(quarterRange(shiftQuarters(q, 1)).start)
    }
  })
})

describe('quarterLabel', () => {
  it('renders the quarter for the prompt prose', () => {
    expect(quarterLabel({ year: 2026, quarter: 3 })).toBe('Q3 2026')
  })
})

// ── The worked examples ──────────────────────────────────────────────────────

/** The `A:` answer for a question, lifted from the live prompt. */
function example(prompt: string, question: string): string {
  const lines = prompt.split('\n')
  const i = lines.findIndex((l) => l.startsWith(`Q: ${question}`))
  expect(i, `no worked example found for: ${question}`).toBeGreaterThan(-1)
  return lines[i + 1].replace(/^A: /, '')
}

const PROMPT = buildSqlSystemPrompt(NOW, CATEGORIES, ACCOUNTS)

const MONTH_COMPARISON = example(PROMPT, 'How does my spending this month compare to last month?')
const AVERAGE_COMPARISON = example(PROMPT, 'Am I spending more on groceries than usual?')
const QUARTER_COMPARISON = example(PROMPT, 'How am I doing this quarter compared with the same quarter last year?')
const HOLISTIC = example(PROMPT, 'Across all my accounts, where is my money actually going this month?')

const NEW_EXAMPLES = {
  'month vs last month': MONTH_COMPARISON,
  'this month vs a prior average': AVERAGE_COMPARISON,
  'quarter vs the same quarter last year': QUARTER_COMPARISON,
  'holistic, no account filter': HOLISTIC,
}

describe('the new worked examples pass every guard the route would run them through', () => {
  // The guard matrix (tests/chatSqlPromptGuardMatrix.test.ts) checks the guards
  // that are prompt-only. These are the ones with real detectors on the route:
  // an example that trips one of them would train the model straight into a
  // refusal, which is the same class of mistake ADR-0011's cross-check catches.
  for (const [label, sql] of Object.entries(NEW_EXAMPLES)) {
    describe(label, () => {
      it('resolves under the money-units classifier rather than being refused (ADR-0020)', () => {
        // The live check on the "/ 100.0 before / N" rule the prompt now states.
        // Write `SUM(...) / 600.0` instead and this goes red: the classifier
        // cannot resolve the units of that expression and refuses the turn.
        expect(moneyUnitsPlan(sql)).toEqual({ kind: 'ok', convertKeys: [] })
      })

      it('carries a transactionType predicate alongside its sign branch (ADR-0016)', () => {
        expect(signBranchGuardViolation(sql)).toBeNull()
      })

      it('never sums transfer rows bare (ADR-0016)', () => {
        expect(transferSumViolation(sql)).toBeNull()
      })

      it('stays inside balance scope (ADR-0015/0017)', () => {
        expect(balanceScopeViolation(sql)).toBeNull()
      })

      it('is not a compound SELECT (ADR-0011)', () => {
        expect(compoundSelectViolation(sql)).toBeNull()
      })
    })
  }
})

describe('the comparative examples are shaped as one row with two labelled columns', () => {
  it('gives each period its own alias', () => {
    expect(MONTH_COMPARISON).toMatch(/AS this_month\b/)
    expect(MONTH_COMPARISON).toMatch(/AS last_month\b/)
    expect(QUARTER_COMPARISON).toMatch(/AS this_quarter\b/)
    expect(QUARTER_COMPARISON).toMatch(/AS same_quarter_last_year\b/)
    expect(AVERAGE_COMPARISON).toMatch(/AS average_prior_month\b/)
  })

  it('puts the period test inside the conditional aggregate, not only in the WHERE', () => {
    for (const sql of [MONTH_COMPARISON, AVERAGE_COMPARISON, QUARTER_COMPARISON]) {
      const projection = sql.slice(0, sql.search(/\bFROM\b/))
      expect((projection.match(/CASE WHEN/gi) ?? []).length, sql).toBeGreaterThanOrEqual(2)
    }
  })

  it('uses the server-supplied quarter literals, not boundaries of its own', () => {
    const thisQ = quarterRange(quarterOf(NOW))
    const lastYearQ = quarterRange(shiftQuarters(quarterOf(NOW), -4))
    expect(QUARTER_COMPARISON).toContain(`date >= '${thisQ.start}' AND date < '${thisQ.endExclusive}'`)
    expect(QUARTER_COMPARISON).toContain(`date >= '${lastYearQ.start}' AND date < '${lastYearQ.endExclusive}'`)
  })

  it('moves with the calendar rather than baking in a quarter', () => {
    const later = buildSqlSystemPrompt(new Date('2027-02-14T00:00:00.000Z'))
    expect(later).toContain('the current quarter is Q1 2027')
    expect(later).toContain("date >= '2027-01-01' AND date < '2027-04-01'")
    expect(later).toContain("date >= '2026-01-01' AND date < '2026-04-01'")
  })

  it('never writes a closed date range against the date column', () => {
    // Transaction.date is a datetime string, so `date <= '2026-09-30'` drops the
    // whole of September 30. Half-open only.
    for (const sql of Object.values(NEW_EXAMPLES)) {
      expect(/\bdate\s*<=\s*'/.test(sql), sql).toBe(false)
    }
  })
})

describe('the holistic example filters on no account at all (input 13)', () => {
  it('neither joins Account nor names one', () => {
    // "Across all my accounts" names accounts without naming ONE account. The
    // temptation this example exists to remove is answering it with a plausible
    // single-account filter, which is ADR-0018's false-empty in a new dress.
    expect(/\bJOIN\b/i.test(HOLISTIC)).toBe(false)
    expect(/\baccountId\s*=/.test(HOLISTIC)).toBe(false)
    expect(/\bname\s*(=|LIKE)/i.test(HOLISTIC)).toBe(false)
  })

  it('answers "where is it going" with a grouped category aggregate', () => {
    expect(HOLISTIC).toMatch(/GROUP BY category/)
  })
})

describe('the comparative shape, executed', () => {
  // The failure a text assertion cannot see: a WHERE clause pinned to one period
  // makes the other column a confident 0.00. So run the real few-shot SQL over a
  // fixture where both periods have known, DIFFERENT, non-zero totals.
  let db: Db

  // The month example filters relatively (date('now', ...)), resolved by SQLite
  // at execution time, so the fixture is dated relative to the real today.
  const ym = (monthsAgo: number) => {
    const d = new Date()
    d.setUTCDate(15)
    d.setUTCMonth(d.getUTCMonth() - monthsAgo)
    return d.toISOString().slice(0, 10) + ' 00:00:00.000'
  }

  beforeAll(() => {
    db = new Database(':memory:')
    db.exec(`CREATE TABLE "Transaction" (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      amount INTEGER NOT NULL,
      description TEXT,
      transactionType TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      parentTransactionId INTEGER,
      reimbursementTxId INTEGER
    )`)

    const insert = db.prepare(
      `INSERT INTO "Transaction" (date, amount, description, transactionType, category, status)
       VALUES (?, ?, ?, ?, ?, 'committed')`,
    )
    // This month: 300.00 of spending. Last month: 125.00. Deliberately unequal,
    // so a query that computed one figure twice would also fail.
    insert.run(ym(0), -20000, 'a', 'debit', '🛒 Groceries')
    insert.run(ym(0), -10000, 'b', 'debit', '🍽️ Dining')
    insert.run(ym(1), -12500, 'c', 'debit', '🛒 Groceries')
    // A transfer pair in this month, larger than either real figure, so leakage
    // cannot hide inside the totals.
    insert.run(ym(0), -90000, 'out', 'transfer', '🚗 Auto loans')
    insert.run(ym(0), 90000, 'in', 'transfer', 'Uncategorized')
    // Older than the window entirely — must not reach either column.
    insert.run(ym(9), -77700, 'old', 'debit', '🛒 Groceries')
  })

  afterAll(() => db?.close())

  it('returns both periods, each with its own real total', () => {
    const row = db.prepare(MONTH_COMPARISON).get() as { this_month: number; last_month: number }
    expect(row.this_month).toBe(300)
    expect(row.last_month).toBe(125)
  })

  it('returns exactly one row', () => {
    expect(db.prepare(MONTH_COMPARISON).all()).toHaveLength(1)
  })

  it('excludes the transfer legs from both columns', () => {
    // Without the transactionType guard, this_month would be 1200.00 (the
    // outgoing leg counted as spending) rather than 300.00.
    const row = db.prepare(MONTH_COMPARISON).get() as { this_month: number }
    expect(row.this_month).not.toBe(1200)
  })

  it('would have reported a false zero had the WHERE been pinned to one month', () => {
    // The mutation the example is written against, pinned here so the reason the
    // WHERE spans both months does not get lost.
    const pinned = MONTH_COMPARISON.replace(
      "date >= date('now','start of month','-1 month')",
      "strftime('%Y-%m', date) = strftime('%Y-%m', date('now'))",
    )
    expect(pinned).not.toBe(MONTH_COMPARISON)
    const row = db.prepare(pinned).get() as { this_month: number; last_month: number }
    expect(row.this_month).toBe(300)
    expect(row.last_month).toBe(0) // a month with 125.00 of spending in it
  })
})
