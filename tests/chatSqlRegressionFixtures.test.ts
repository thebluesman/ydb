import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as Db } from 'better-sqlite3'
import { balanceIntentMatch, balanceIntentMessage } from '@/lib/chatBalanceIntent'
import { balanceScopeMessage, balanceScopeViolation } from '@/lib/chatBalanceScope'
import { compoundSelectMessage, compoundSelectViolation } from '@/lib/chatCompoundSelect'
import { unknownCategoryLiterals, unknownCategoryMessage } from '@/lib/chatCategoryVocabulary'
import { NON_ANSWER_HEADLINE, isNonAnswerReason, type NonAnswerReason } from '@/lib/chatNonAnswer'

// ─────────────────────────────────────────────────────────────────────────────
// [chat-sql] 5 — regression fixtures for the 2026-07-29/30 manual chat sessions.
//
// Every bug in this initiative was a WELL-FORMED, SUCCESSFULLY-EXECUTING query.
// There is no exception to assert on. The only observable difference between a
// correct answer and a confidently wrong one is the refusal — so these tests
// assert on the refusal REASON, and on the figures the surviving queries return.
//
// Why this file exists separately from the per-guard suites
// --------------------------------------------------------
// tests/chatBalanceScope.test.ts, chatCompoundSelect.test.ts and
// chatCategoryVocabulary.test.ts each exercise ONE guard against its own cases.
// None of them asserts what this initiative actually risks: that a plain
// transaction-level aggregate survives ALL the guards at once. Each new check is
// a fresh chance to over-reject the ordinary queries, and that risk exists only
// across the set. `runGuardChain` below is the cross-cutting assertion.
//
// Fixture provenance — READ THIS BEFORE ADDING ONE
// -----------------------------------------------
// The ticket names the persisted `ChatMessage.sql` rows from the 2026-07-29
// sessions as the fixture source. Those rows are GONE: prisma/dev.db retains a
// single chat session (2026-07-31) and every backup in backups/ predates
// 2026-07-16. Sessions 6 and 9 — the ticket's named over-rejection canaries —
// are not recoverable verbatim from anywhere in the repo or the database.
//
// So provenance here is mixed, and each fixture says which it is:
//   [verbatim-adr]  quoted in the ADR that the bug produced — exact.
//   [verbatim-db]   a persisted ChatMessage.sql row still in prisma/dev.db.
//   [reconstructed] the shape described in the ADR/ticket, rewritten here.
// Reconstructed fixtures are weaker evidence. Prefer verbatim when a future
// session gives you the chance, and do not delete chat sessions that produced a
// bug before the fixture is extracted.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The stored category vocabulary the guards ground against (ADR-0008).
 * Emoji-prefixed, because that is what the real `Transaction.category` values
 * look like and it is the exact reason bare-name guesses were mis-matching.
 */
const CATEGORIES = [
  '🚗 Auto loans',
  '🛒 Groceries',
  '✈️ Travel',
  '🍿 Entertainment',
  '⛽ Fuel',
]

type GuardOutcome = {
  reason: NonAnswerReason
  /** Which guard fired — for asserting the reason is attributable, not just present. */
  guard: 'balance-intent' | 'category-vocabulary' | 'balance-scope' | 'compound-select'
  detail: string
  message: string
}

/**
 * The route's guard chain, in the order app/api/chat/route.ts applies it.
 *
 * Deliberately a re-statement rather than an import: the route is a streaming
 * handler that needs Ollama, a request body and a database, and running it would
 * make these fixtures slow and non-deterministic. The ORDER is the part being
 * pinned — a question-level refusal (ADR-0015) must win over any SQL-level one,
 * because it fires before a token is spent.
 *
 * If route.ts adds, removes or reorders a guard, this function must change with
 * it, and the over-rejection canaries below are what will catch the difference.
 */
function runGuardChain(question: string, sql: string, categories = CATEGORIES): GuardOutcome | null {
  const intent = balanceIntentMatch(question)
  if (intent) {
    return {
      reason: 'out-of-scope',
      guard: 'balance-intent',
      detail: intent.phrase,
      message: balanceIntentMessage(intent),
    }
  }

  const unknown = unknownCategoryLiterals(sql, categories)
  if (unknown.length > 0) {
    return {
      reason: 'out-of-scope',
      guard: 'category-vocabulary',
      detail: unknown.join(', '),
      message: unknownCategoryMessage(unknown, categories),
    }
  }

  const scope = balanceScopeViolation(sql)
  if (scope) {
    return {
      reason: 'out-of-scope',
      guard: 'balance-scope',
      detail: scope.kind,
      message: balanceScopeMessage(scope),
    }
  }

  const compound = compoundSelectViolation(sql)
  if (compound) {
    return {
      reason: 'unsupported-shape',
      guard: 'compound-select',
      detail: compound.keyword,
      message: compoundSelectMessage(compound),
    }
  }

  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture corpus
// ─────────────────────────────────────────────────────────────────────────────

/** Session 10, "which should I pay off first". [verbatim-adr] ADR-0010 §Context. */
const SESSION_10_SQL =
  'SELECT Account.name, SUM("Transaction".amount) / 100.0 AS total_balance FROM "Transaction" ' +
  'JOIN Account ON Account.id = "Transaction".accountId ' +
  "WHERE Account.type = 'liability' AND strftime('%Y-%m', \"Transaction\".date) = '2026-07' " +
  'GROUP BY Account.name'

/**
 * The ADR-0015 re-run of the same intent: a bare `SUM(amount) AS net` that no
 * alias check can catch, narrated as "The balance on your car loan is …".
 * [verbatim-adr] ADR-0015 §Context.
 */
const SESSION_10_EVADED_SQL =
  "SELECT SUM(amount) / 100.0 AS net FROM \"Transaction\" WHERE category = '🚗 Auto loans'"

/** Session 11, "if I lose my job, how long could I cover expenses". [verbatim-adr] ADR-0011 §Context. */
const SESSION_11_SQL =
  'SELECT SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) / 100.0 AS total_expenses FROM "Transaction" ' +
  'UNION ALL ' +
  'SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) / 100.0 AS total_income FROM "Transaction"'

describe('must be declined — the four confident-wrong-number fixtures', () => {
  it('session 10: a liability SUM(amount) aliased as a balance (ADR-0010)', () => {
    const outcome = runGuardChain('Which of these should I pay off first?', SESSION_10_SQL)
    expect(outcome).not.toBeNull()
    // The question-level check fires first here — "pay off"/"debt" wording is
    // itself out of scope under ADR-0015 — which is the intended belt-and-braces.
    expect(outcome!.reason).toBe('out-of-scope')

    // ADR-0010's alias net must independently catch it, for the case where the
    // question named no stock noun. That is the "second net" the route keeps.
    const scope = balanceScopeViolation(SESSION_10_SQL)
    expect(scope).toEqual({ kind: 'balance-alias', alias: 'total_balance', word: 'balance' })
  })

  it('session 10 evaded: `SUM(amount) AS net` for a balance question (ADR-0015)', () => {
    // The whole point of ADR-0015: the alias check cannot see this one.
    expect(balanceScopeViolation(SESSION_10_EVADED_SQL)).toBeNull()

    const outcome = runGuardChain("What's the balance on my car loan?", SESSION_10_EVADED_SQL)
    expect(outcome).not.toBeNull()
    expect(outcome!.guard).toBe('balance-intent')
    expect(outcome!.reason).toBe('out-of-scope')
    expect(outcome!.message).toMatch(/net flow|balance/i)
  })

  it.each([
    ["Which debt should I pay off first?", 'debt'],
    ['How much do I owe on my car loan?', 'owe'],
    ["What's my net worth right now?", 'net worth'],
    ['What is the outstanding amount on the credit card?', 'outstanding'],
    ['How much is left on my car loan?', 'how much is left on'],
  ])('question-level refusal: %j is declined before SQL is generated', (question, phrase) => {
    const match = balanceIntentMatch(question)
    expect(match, question).not.toBeNull()
    expect(match!.phrase).toBe(phrase)
  })

  it('a category literal with no match in the stored vocabulary refuses, and does not return zero (ADR-0008)', () => {
    // The live "Sports" bug: a nonexistent category the model would otherwise
    // silently swap for Uncategorized, or sum to a plausible-looking 0.
    const sql = "SELECT SUM(-amount) / 100.0 AS total FROM \"Transaction\" WHERE category = 'Sports'"
    const outcome = runGuardChain('How much did I spend on sports?', sql)

    expect(outcome).not.toBeNull()
    expect(outcome!.guard).toBe('category-vocabulary')
    expect(outcome!.reason).toBe('out-of-scope')
    expect(outcome!.detail).toBe('Sports')
    // Loud, not quiet: the message must deny the zero explicitly, per the
    // financial-data bar — a wrong number is worse than a refusal.
    expect(outcome!.message).not.toMatch(/\bAED 0\b|\btotal of 0\b/)
    // It must deny the equivalence outright: an empty result is not a zero total.
    expect(outcome!.message).toMatch(/empty total, which is not the same as spending nothing/i)
  })

  it('a bare name for an emoji-prefixed stored category refuses rather than matching nothing (ADR-0008)', () => {
    // The concrete trigger for ADR-0008: stored values carry an emoji prefix,
    // the model writes the bare word, the query runs clean and matches nothing.
    const sql = "SELECT SUM(-amount) / 100.0 AS total FROM \"Transaction\" WHERE category = 'Travel'"
    const outcome = runGuardChain('How much did I spend on travel?', sql)

    expect(outcome).not.toBeNull()
    expect(outcome!.guard).toBe('category-vocabulary')
    expect(outcome!.detail).toBe('Travel')
    // And it must offer the stored spelling, or the refusal is a dead end.
    expect(outcome!.message).toContain('✈️ Travel')
  })
})

describe('must not mislabel — compound SELECTs (ADR-0011)', () => {
  it('session 11 is refused as unsupported-shape, not out-of-scope', () => {
    const outcome = runGuardChain(
      'If I lose my job, how long could I cover expenses?',
      SESSION_11_SQL,
    )
    expect(outcome).not.toBeNull()
    expect(outcome!.guard).toBe('compound-select')
    // The distinction ADR-0014's addendum draws: the question was fine, the
    // artifact wasn't. Getting this wrong tells the user to stop asking.
    expect(outcome!.reason).toBe('unsupported-shape')
    expect(outcome!.detail).toBe('UNION ALL')
  })

  it.each(['UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT'])(
    '%s is refused — the first-branch naming rule is a property of all compound SELECTs',
    (op) => {
      const sql = `SELECT SUM(amount) AS a FROM "Transaction" ${op} SELECT COUNT(*) AS b FROM "Transaction"`
      const outcome = runGuardChain('two figures please', sql)
      expect(outcome, op).not.toBeNull()
      expect(outcome!.reason).toBe('unsupported-shape')
    },
  )

  it.each([
    ['an identifier containing the word', 'SELECT COUNT(*) AS except_flag FROM "Transaction"'],
    ['a string literal containing the word', `SELECT COUNT(*) AS n FROM "Transaction" WHERE description = 'union square'`],
  ])('no false positive on %s', (_label, sql) => {
    expect(runGuardChain('how many?', sql)).toBeNull()
  })
})

describe('the guard chain never over-rejects an ordinary aggregate', () => {
  // The ticket's named canaries are sessions 6 and 9. Those rows are gone (see
  // the provenance note at the top), so these are the closest available
  // equivalent: plain transaction-level aggregates taken verbatim from the one
  // chat session prisma/dev.db still holds. Same role — if any current or future
  // guard starts rejecting these, an ordinary question has stopped working.
  //
  // One substitution, deliberate: the persisted vendor-filter query matched on
  // Shyam's real employer name. Replaced with a neutral literal. Nothing about
  // the query shape depends on the string.
  const CANARIES: Array<[string, string, string]> = [
    [
      'total expenses this month [verbatim-db]',
      'Is there any room for savings in my expenses?',
      'SELECT SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) / 100.0 AS total_expenses ' +
        'FROM "Transaction" WHERE transactionType != \'transfer\' AND parentTransactionId IS NULL ' +
        "AND strftime('%Y-%m', date) = strftime('%Y-%m', date('now')) " +
        "AND status IN ('committed','reconciled') LIMIT 200",
    ],
    [
      'spending by category this month [verbatim-db]',
      'Where can I cut down in my expenses?',
      'SELECT category, SUM(amount) / 100.0 AS total_expenses FROM "Transaction" ' +
        "WHERE amount < 0 AND transactionType != 'transfer' AND parentTransactionId IS NULL " +
        "AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = strftime('%Y-%m', date('now')) " +
        "AND status IN ('committed','reconciled') GROUP BY category ORDER BY total_expenses DESC LIMIT 200",
    ],
    [
      'income and expenses split by transactionType [verbatim-db, vendor anonymised]',
      "What's my income and spending this month?",
      "SELECT SUM(CASE WHEN T1.amount > 0 AND T1.transactionType = 'credit' THEN T1.amount ELSE 0 END) / 100.0 AS total_income, " +
        "SUM(CASE WHEN T1.amount < 0 AND T1.transactionType != 'transfer' THEN -T1.amount ELSE 0 END) / 100.0 AS total_expenses " +
        'FROM "Transaction" T1 ' +
        "WHERE T1.status IN ('committed','reconciled') AND T1.description LIKE '%ACME PAYROLL%' " +
        "AND strftime('%Y-%m', T1.date) = strftime('%Y-%m', date('now'))",
    ],
    [
      'a grounded category filter, emoji spelling copied exactly [reconstructed]',
      'How much did I spend on groceries this month?',
      'SELECT SUM(-amount) / 100.0 AS total FROM "Transaction" ' +
        "WHERE category = '🛒 Groceries' AND transactionType != 'transfer' AND parentTransactionId IS NULL",
    ],
    [
      'a monthly trend [reconstructed]',
      'What did my spending look like month by month?',
      "SELECT strftime('%Y-%m', date) AS month, SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) / 100.0 AS total " +
        'FROM "Transaction" WHERE transactionType != \'transfer\' AND parentTransactionId IS NULL GROUP BY month ORDER BY month',
    ],
  ]

  it.each(CANARIES)('%s passes every guard', (_label, question, sql) => {
    const outcome = runGuardChain(question, sql)
    expect(outcome, outcome ? `${outcome.guard}: ${outcome.detail}` : '').toBeNull()
  })

  it('the canaries would still pass if the guards were applied in any order', () => {
    // Order-independence is the strongest statement of "no over-rejection":
    // no single guard objects, so no reordering of route.ts can change the answer.
    for (const [label, , sql] of CANARIES) {
      expect(unknownCategoryLiterals(sql, CATEGORIES), label).toEqual([])
      expect(balanceScopeViolation(sql), label).toBeNull()
      expect(compoundSelectViolation(sql), label).toBeNull()
    }
  })

  it('every canary question is a flow question, so none trips the ADR-0015 pre-check', () => {
    for (const [label, question] of CANARIES) {
      expect(balanceIntentMatch(question), `${label}: ${question}`).toBeNull()
    }
  })
})

describe('canary figures are unchanged — executed against a seeded ledger', () => {
  let db: Db

  // Current UTC month, because the canaries filter relatively against
  // date('now') and SQLite resolves that in UTC at execution time.
  const now = new Date()
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`

  beforeAll(() => {
    db = new Database(':memory:')
    db.exec(`CREATE TABLE "Transaction" (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      amount INTEGER NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      transactionType TEXT NOT NULL,
      category TEXT NOT NULL,
      accountId INTEGER NOT NULL,
      status TEXT NOT NULL,
      parentTransactionId INTEGER,
      reimbursementTxId INTEGER
    )`)

    const insert = db.prepare(
      `INSERT INTO "Transaction" (id, date, amount, description, transactionType, category, accountId, status, parentTransactionId, reimbursementTxId)
       VALUES (@id, @date, @amount, @description, @transactionType, @category, @accountId, @status, @parentTransactionId, @reimbursementTxId)`
    )
    const row = (
      id: number,
      day: string,
      amount: number,
      transactionType: string,
      category: string,
      status = 'committed',
      description = '',
      parentTransactionId: number | null = null,
      reimbursementTxId: number | null = null,
    ) => ({
      id, date: `${ym}-${day} 00:00:00.000`, amount, description, transactionType,
      category, accountId: 1, status, parentTransactionId, reimbursementTxId,
    })

    const rows = [
      // Income: 5,000.00
      row(1, '02', 500_000, 'credit', '💼 Salary', 'committed', 'ACME PAYROLL JUL'),
      // Expenses: 120.00 groceries + 80.00 groceries + 60.00 fuel = 260.00
      row(2, '03', -12_000, 'debit', '🛒 Groceries'),
      row(3, '04', -8_000, 'debit', '🛒 Groceries', 'reconciled'),
      row(4, '05', -6_000, 'debit', '⛽ Fuel'),
      // Transfer pair, 9,000.00 each way — must reach neither figure.
      row(5, '06', -900_000, 'transfer', '↔️ Transfer'),
      row(6, '06', 900_000, 'transfer', '↔️ Transfer'),
      // A split child: excluded by parentTransactionId IS NULL, else double-counted.
      row(7, '07', -5_000, 'debit', '🍿 Entertainment', 'committed', '', 2, null),
      // A review-status row: excluded by the status filter.
      row(8, '08', -77_777, 'debit', '🛒 Groceries', 'review'),
    ]
    for (const r of rows) insert.run(r)
  })

  afterAll(() => db.close())

  it('total expenses this month excludes transfers, split children and unreviewed rows', () => {
    const sql =
      'SELECT SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) / 100.0 AS total_expenses ' +
      'FROM "Transaction" WHERE transactionType != \'transfer\' AND parentTransactionId IS NULL ' +
      "AND strftime('%Y-%m', date) = strftime('%Y-%m', date('now')) " +
      "AND status IN ('committed','reconciled') LIMIT 200"
    const out = db.prepare(sql).get() as { total_expenses: number }
    expect(out.total_expenses).toBe(260)
  })

  it('income and expenses are both free of transfer legs (PR #32 regression)', () => {
    const sql =
      "SELECT SUM(CASE WHEN T1.amount > 0 AND T1.transactionType = 'credit' THEN T1.amount ELSE 0 END) / 100.0 AS total_income, " +
      "SUM(CASE WHEN T1.amount < 0 AND T1.transactionType != 'transfer' THEN -T1.amount ELSE 0 END) / 100.0 AS total_expenses " +
      'FROM "Transaction" T1 ' +
      "WHERE T1.status IN ('committed','reconciled') AND strftime('%Y-%m', T1.date) = strftime('%Y-%m', date('now'))"
    const out = db.prepare(sql).get() as { total_income: number; total_expenses: number }
    expect(out.total_income).toBe(5_000)
    // 260.00 of real expenses plus the 50.00 split child, which this shape does
    // not exclude — pinned as the figure that shipped, not endorsed as correct.
    expect(out.total_expenses).toBe(310)
    // The load-bearing assertion: 9,000.00 of transfer legs reached neither.
    expect(out.total_income).toBeLessThan(9_000)
    expect(out.total_expenses).toBeLessThan(9_000)
  })

  it('dropping the transactionType guard reintroduces the bug, so the guard is what works', () => {
    const unguarded =
      'SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) / 100.0 AS total_income, ' +
      'SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) / 100.0 AS total_expenses ' +
      'FROM "Transaction" WHERE status IN (\'committed\',\'reconciled\') ' +
      "AND strftime('%Y-%m', date) = strftime('%Y-%m', date('now'))"
    const out = db.prepare(unguarded).get() as { total_income: number; total_expenses: number }
    expect(out.total_income).toBe(5_000 + 9_000)
    expect(out.total_expenses).toBe(310 + 9_000)
  })

  it('SUM over transfer rows nets to zero, which is why transfer volume needs a sign split (PR #32)', () => {
    const naive = db
      .prepare(`SELECT SUM(amount) / 100.0 AS volume FROM "Transaction" WHERE transactionType = 'transfer'`)
      .get() as { volume: number }
    expect(naive.volume).toBe(0)

    const correct = db
      .prepare(
        `SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) / 100.0 AS volume ` +
          `FROM "Transaction" WHERE transactionType = 'transfer'`
      )
      .get() as { volume: number }
    expect(correct.volume).toBe(9_000)
  })

  it("session 11's UNION ALL really does collapse both labels onto the first branch", () => {
    // The mechanism the ban exists for. Asserted against real SQLite rather than
    // taken on faith from the ADR, because if SQLite ever changed this the ban
    // would be load-bearing for no reason.
    const rows = db.prepare(SESSION_11_SQL).all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(Object.keys(r)).toEqual(['total_expenses'])
    }
    // Both rows keyed the same: the income figure arrives labelled as expenses,
    // and by the time the route holds row objects the real label is unrecoverable.
    expect(rows[0].total_expenses).not.toBe(rows[1].total_expenses)
  })
})

describe('refusal reasons are distinguishable', () => {
  const cases: Array<[string, string, string, NonAnswerReason]> = [
    ['balance question', "What's my net worth?", 'SELECT 1', 'out-of-scope'],
    [
      'unknown category',
      'spent on sports?',
      "SELECT SUM(amount) AS total FROM \"Transaction\" WHERE category = 'Sports'",
      'out-of-scope',
    ],
    [
      'balance alias',
      'summarise my liabilities by account',
      'SELECT SUM(amount) AS total_balance FROM "Transaction"',
      'out-of-scope',
    ],
    ['compound select', 'two figures', SESSION_11_SQL, 'unsupported-shape'],
  ]

  it.each(cases)('%s yields reason %s', (_label, question, sql, expected) => {
    const outcome = runGuardChain(question, sql)
    expect(outcome).not.toBeNull()
    expect(outcome!.reason).toBe(expected)
    expect(isNonAnswerReason(outcome!.reason)).toBe(true)
  })

  it('each guard writes its own message — no two refusals read alike', () => {
    const messages = cases.map(([, q, s]) => runGuardChain(q, s)!.message)
    expect(new Set(messages).size).toBe(messages.length)
  })

  it('every message says what was declined and why, never bare "error"', () => {
    for (const [label, question, sql] of cases) {
      const { message } = runGuardChain(question, sql)!
      // A refusal the user cannot act on is indistinguishable from a crash,
      // which is the failure mode ADR-0014 exists to prevent.
      expect(message.length, label).toBeGreaterThan(80)
      expect(message, label).not.toMatch(/^error/i)
    }
  })

  it('the two reasons in play carry different headlines in the UI', () => {
    expect(NON_ANSWER_HEADLINE['out-of-scope']).not.toBe(NON_ANSWER_HEADLINE['unsupported-shape'])
  })

  it('a genuine SQLite error is not one of these refusals', () => {
    // The route surfaces a real execution failure as an HTTP error with a
    // `SQL error:` message, never as a no-answer frame. A query that is merely
    // broken must therefore pass the guard chain untouched and fail at execution.
    const broken = 'SELECT SUM(amount) AS total FROM "Transaction" WHERE nonexistent_column = 1'
    expect(runGuardChain('how much?', broken)).toBeNull()

    const db = new Database(':memory:')
    db.exec('CREATE TABLE "Transaction" (id INTEGER PRIMARY KEY, amount INTEGER)')
    expect(() => db.prepare(broken).all()).toThrow(/nonexistent_column/)
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Known gaps — two of the ticket's "must be declined" fixtures do not decline.
//
// These use `it.fails`, which PASSES while the gap exists and turns RED the
// moment the behaviour changes. That keeps CI green without pretending the
// fixture is covered, and forces whoever closes the gap to come back here and
// convert the test into a real assertion. Do not delete them to make the suite
// tidy; they are the ticket's acceptance criteria, unmet.
//
// Both are @backend-engineer / @tech-lead work, not QA's to fix.
// ─────────────────────────────────────────────────────────────────────────────
describe('KNOWN GAPS (tripwires — a failure here means the gap closed, update the test)', () => {
  it.fails('GAP 1: `SELECT *` whose result rows carry openingBalance is not declined', () => {
    // The ticket calls this out explicitly: "text-matching the query alone won't
    // catch it". balanceScopeViolation reads the SQL string, and this string
    // never contains the word — the column arrives via the star expansion.
    // Nothing in the route inspects result-row KEYS, so openingBalance reaches
    // narration and can be reported as a current balance.
    const sql = "SELECT * FROM Account WHERE type = 'liability'"

    // Proof the column really does arrive:
    const db = new Database(':memory:')
    db.exec('CREATE TABLE Account (id INTEGER PRIMARY KEY, name TEXT, type TEXT, openingBalance INTEGER)')
    db.prepare("INSERT INTO Account VALUES (1, 'Car loan', 'liability', -7034_04)").run()
    const rows = db.prepare(sql).all() as Array<Record<string, unknown>>
    db.close()
    expect(Object.keys(rows[0])).toContain('openingBalance')

    // ...and this is what should happen, but does not:
    expect(runGuardChain('show me my loan accounts', sql)).not.toBeNull()
  })

  it.fails("GAP 2: Account.name LIKE '%credit card%' matching nothing is not declined", () => {
    // Session 10's predicate. ADR-0008's grounding was extended to account names
    // by the [chat-sql] 2 ticket's scope call, but the implementation shipped
    // categories only — lib/chatCategoryVocabulary.ts says so in its header
    // ("Scope is categories only"). So an account-name guess that matches no
    // stored account still runs clean and returns an empty result, which is the
    // exact false-"no data" shape ADR-0008 was written to stop.
    const sql =
      'SELECT a.name, SUM(t.amount) / 100.0 AS total FROM "Transaction" t ' +
      'JOIN Account a ON a.id = t.accountId ' +
      "WHERE a.name LIKE '%credit card%' GROUP BY a.name"

    expect(runGuardChain('what did I put on the credit card?', sql)).not.toBeNull()
  })
})
