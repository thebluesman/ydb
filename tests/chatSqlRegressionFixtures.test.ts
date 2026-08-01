import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as Db } from 'better-sqlite3'
import { balanceIntentMatch, balanceIntentMessage } from '@/lib/chatBalanceIntent'
import {
  balanceScopeMessage,
  balanceScopeRowMessage,
  balanceScopeRowViolation,
  balanceScopeViolation,
} from '@/lib/chatBalanceScope'
import { compoundSelectMessage, compoundSelectViolation } from '@/lib/chatCompoundSelect'
import {
  signBranchGuardMessage,
  signBranchGuardViolation,
  transferSumMessage,
  transferSumViolation,
} from '@/lib/chatMoneyGuards'
import { unknownCategoryLiterals, unknownCategoryMessage } from '@/lib/chatCategoryVocabulary'
import { unknownAccountLiterals, unknownAccountMessage } from '@/lib/chatAccountVocabulary'
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

/**
 * The stored `Account.name` vocabulary the account guard grounds against.
 *
 * Named after their banks, which is the point: session 10's model wrote
 * `LIKE '%credit card%'`, a description of an account TYPE, and no real ledger
 * names an account that way. The generic phrase matching nothing is the bug.
 */
const ACCOUNTS = [
  'ADCB Current',
  'Emirates NBD Savings',
  'Mashreq Neo Visa',
  '🚗 Car loan',
]

type GuardOutcome = {
  reason: NonAnswerReason
  /** Which guard fired — for asserting the reason is attributable, not just present. */
  guard:
    | 'balance-intent'
    | 'category-vocabulary'
    | 'account-vocabulary'
    | 'balance-scope'
    | 'compound-select'
    | 'sign-branch-guard'
    | 'transfer-sum'
    | 'balance-scope-rows'
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
 *
 * `rows` is the one thing this re-statement cannot fabricate. Since 2026-08-01
 * the route runs a final balance-scope check on the columns the query actually
 * RETURNED, because a `SELECT *` cannot be judged from the query string — the
 * schema decides its column list, not the model. Callers that care about that
 * guard execute the SQL themselves and hand the rows in; callers that don't pass
 * nothing, and the row check is a no-op on an empty result exactly as it is in
 * the route. This is the only place the chain is not a pure function of text,
 * and it is a property of the guard, not of the harness.
 */
type GuardChainOptions = {
  categories?: string[]
  accounts?: string[]
  /** Result rows, when the caller executed the query. */
  rows?: unknown[]
}

function runGuardChain(
  question: string,
  sql: string,
  opts: GuardChainOptions = {},
): GuardOutcome | null {
  const categories = opts.categories ?? CATEGORIES
  const accounts = opts.accounts ?? ACCOUNTS
  const rows = opts.rows ?? []

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

  const unknownAccounts = unknownAccountLiterals(sql, accounts)
  if (unknownAccounts.length > 0) {
    return {
      reason: 'out-of-scope',
      guard: 'account-vocabulary',
      detail: unknownAccounts.join(', '),
      message: unknownAccountMessage(unknownAccounts, accounts),
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

  const signBranch = signBranchGuardViolation(sql)
  if (signBranch) {
    return {
      reason: 'unsupported-shape',
      guard: 'sign-branch-guard',
      detail: signBranch.branch,
      message: signBranchGuardMessage(signBranch),
    }
  }

  const transferSum = transferSumViolation(sql)
  if (transferSum) {
    return {
      reason: 'unsupported-shape',
      guard: 'transfer-sum',
      detail: transferSum.pin,
      message: transferSumMessage(transferSum),
    }
  }

  // Post-execution, and last: everything above refuses before a query runs, so
  // this only ever sees a result set the text checks were happy to produce.
  const scopeRows = balanceScopeRowViolation(rows)
  if (scopeRows) {
    return {
      reason: 'out-of-scope',
      guard: 'balance-scope-rows',
      detail: scopeRows.column,
      message: balanceScopeRowMessage(scopeRows),
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
describe('must not miscount money — the two PR #32 shapes (ADR-0016)', () => {
  // ADR-0016 § Consequences names these two as regression cases, and names the
  // transfer-volume few-shot as the thing they must NOT catch. All three live
  // here rather than in the per-detector suite because the point is the chain:
  // each new check is a fresh chance to refuse an ordinary question.

  /**
   * PR #32's first bug. Income and expenses split by sign with no transactionType
   * predicate: every transfer's outgoing leg is counted as spending and its
   * incoming leg as income, so both figures come back too high by the amount
   * moved. [reconstructed] — the shape ADR-0016 § Context describes.
   */
  const UNGUARDED_SIGN_SPLIT =
    'SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) / 100.0 AS total_income, ' +
    'SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) / 100.0 AS total_expenses ' +
    'FROM "Transaction" WHERE status IN (\'committed\',\'reconciled\') ' +
    "AND strftime('%Y-%m', date) = strftime('%Y-%m', date('now'))"

  /**
   * PR #32's second bug: transfer volume as a bare SUM over transfer-pinned rows.
   * Nets to approximately zero for any ledger. [reconstructed].
   */
  const NAIVE_TRANSFER_SUM =
    "SELECT SUM(amount) / 100.0 AS total FROM \"Transaction\" WHERE transactionType = 'transfer' " +
    "AND strftime('%Y', date) = strftime('%Y', date('now')) AND status IN ('committed','reconciled')"

  /** The prompt's own transfer-volume answer, verbatim in shape. [verbatim-prompt]. */
  const TRANSFER_VOLUME_FEWSHOT =
    'SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) / 100.0 AS total FROM "Transaction" ' +
    "WHERE transactionType = 'transfer' AND strftime('%Y', date) = strftime('%Y', date('now')) " +
    "AND status IN ('committed','reconciled')"

  it('a sign-branching query with no transactionType predicate is refused', () => {
    const outcome = runGuardChain("What's my income and spending this month?", UNGUARDED_SIGN_SPLIT)
    expect(outcome).not.toBeNull()
    expect(outcome!.guard).toBe('sign-branch-guard')
    // The question was ordinary; the query we wrote for it wasn't.
    expect(outcome!.reason).toBe('unsupported-shape')
    // Names the arithmetic, per ADR-0016's requirement on the refusal copy.
    expect(outcome!.message).toMatch(/too high/i)
    expect(outcome!.message).toMatch(/transfer/i)
  })

  it('SUM(amount) over transfer-pinned rows is refused', () => {
    const outcome = runGuardChain('How much did I move between my accounts this year?', NAIVE_TRANSFER_SUM)
    expect(outcome).not.toBeNull()
    expect(outcome!.guard).toBe('transfer-sum')
    expect(outcome!.reason).toBe('unsupported-shape')
    // It must deny the zero outright, the same way ADR-0008's refusal denies the
    // empty total: a confident "nothing" is the wrong answer, not a small one.
    expect(outcome!.message).toMatch(/zero/i)
  })

  it('the transfer-volume few-shot itself still passes both', () => {
    // The load-bearing non-rejection. It branches on sign AND pins to transfers —
    // the exact intersection of the two triggers — and is entirely correct,
    // because the check demands SOME transactionType predicate rather than a
    // particular one, and its SUM is conditional rather than bare.
    expect(signBranchGuardViolation(TRANSFER_VOLUME_FEWSHOT)).toBeNull()
    expect(transferSumViolation(TRANSFER_VOLUME_FEWSHOT)).toBeNull()
    expect(runGuardChain('How much did I move between my accounts this year?', TRANSFER_VOLUME_FEWSHOT))
      .toBeNull()
  })

  it('adding the transactionType guard is all it takes to un-refuse the sign split', () => {
    // Proof the detector objects to the missing guard and nothing else — an
    // over-rejecting check that cannot be satisfied is a dead end, not a guard.
    const guarded = UNGUARDED_SIGN_SPLIT.replace(
      'WHERE status',
      "WHERE transactionType != 'transfer' AND status",
    )
    expect(runGuardChain("What's my income and spending this month?", guarded)).toBeNull()
  })
})

// The ticket's named canaries are sessions 6 and 9. Those rows are gone (see
// the provenance note at the top), so these are the closest available
// equivalent: plain transaction-level aggregates taken verbatim from the one
// chat session prisma/dev.db still holds. Same role — if any current or future
// guard starts rejecting these, an ordinary question has stopped working.
//
// One substitution, deliberate: the persisted vendor-filter query matched on
// Shyam's real employer name. Replaced with a neutral literal. Nothing about
// the query shape depends on the string.
//
// Module-scoped rather than local to the describe below, so a newly added guard
// can be pointed at the same list from its own suite (see the account-name
// guard's closure tests).
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

describe('the guard chain never over-rejects an ordinary aggregate', () => {
  it.each(CANARIES)('%s passes every guard', (_label, question, sql) => {
    const outcome = runGuardChain(question, sql)
    expect(outcome, outcome ? `${outcome.guard}: ${outcome.detail}` : '').toBeNull()
  })

  it('the canaries would still pass if the guards were applied in any order', () => {
    // Order-independence is the strongest statement of "no over-rejection":
    // no single guard objects, so no reordering of route.ts can change the answer.
    for (const [label, , sql] of CANARIES) {
      expect(unknownCategoryLiterals(sql, CATEGORIES), label).toEqual([])
      expect(unknownAccountLiterals(sql, ACCOUNTS), label).toEqual([])
      expect(balanceScopeViolation(sql), label).toBeNull()
      expect(compoundSelectViolation(sql), label).toBeNull()
      expect(signBranchGuardViolation(sql), label).toBeNull()
      expect(transferSumViolation(sql), label).toBeNull()
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

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0019 — a transfer leg carrying a real spend category.
//
// The PR #32 transfer bugs above are the classic shape: both legs are
// `Uncategorized`, they are equal and opposite, and a sign split counts one as
// income and one as an expense. This is a different and nastier one, and it was
// unwritable until ADR-0019 measured prisma/dev.db on 2026-08-01: all 44
// transfer rows carry a nonempty category and 5 carry a REAL spend category —
// 3 `🚗 Auto loans`, 2 `💰 Personal loans` — assigned upstream by the
// SMS-capture/YNAB pipeline, not by anything this repo controls.
//
// The category sits on the OUTGOING leg only (id=521, -234468, `🚗 Auto loans`,
// linked to id=522, +234468, `Uncategorized`). So nothing cancels: a
// category-filtered `SUM(amount)` over `🚗 Auto loans` returns the full
// repayment volume as spending, with no arithmetic tell. The prompt's own rule —
// "transfers are NEITHER income NOR spending" — is violated by a query that
// never mentions the sign of amount and therefore never tripped the old trigger.
//
// The mirror is the reason this stays prompt-only: "how much did I SPEND on Auto
// loans" and "how much did I PAY on my car loan" generate the same SQL and want
// opposite answers. Asserted below as a property of the guard chain, because a
// detector that could tell them apart is what ADR-0016 concluded does not exist.
// ─────────────────────────────────────────────────────────────────────────────
describe('ADR-0019: a category-filtered spend total must not count transfer legs', () => {
  let db: Db

  const now = new Date()
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`

  /**
   * The shape the three worked examples now teach, down to the bare SUM(amount)
   * they use — so spending reads as a negative figure here, as it does in the app.
   */
  const GUARDED =
    `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE category = '🚗 Auto loans' ` +
    `AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL ` +
    `AND status IN ('committed','reconciled')`

  /** The shape they taught before this ticket. Same question, wrong number. */
  const UNGUARDED =
    `SELECT SUM(amount) / 100.0 AS total FROM "Transaction" WHERE category = '🚗 Auto loans' ` +
    `AND parentTransactionId IS NULL AND reimbursementTxId IS NULL ` +
    `AND status IN ('committed','reconciled')`

  // A separate in-memory ledger rather than rows added to the canary fixture
  // above: the canary figures are pinned, and a second transfer pair there would
  // move them for a reason unrelated to what they exist to protect.
  beforeAll(() => {
    db = new Database(':memory:')
    db.exec(`CREATE TABLE "Transaction" (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      amount INTEGER NOT NULL,
      transactionType TEXT NOT NULL,
      category TEXT NOT NULL,
      status TEXT NOT NULL,
      linkedTransferId INTEGER,
      parentTransactionId INTEGER,
      reimbursementTxId INTEGER
    )`)
    const insert = db.prepare(
      `INSERT INTO "Transaction" (id, date, amount, transactionType, category, status, linkedTransferId)
       VALUES (@id, @date, @amount, @transactionType, @category, 'committed', @linkedTransferId)`
    )
    const rows = [
      // The loan repayment, modelled on dev.db ids 521/522. AED 2,344.68 moved
      // from the current account to the car loan. Category on the outgoing leg
      // only; the counterpart is Uncategorized, so the two do NOT cancel under a
      // category filter.
      { id: 521, date: `${ym}-10 00:00:00.000`, amount: -234_468, transactionType: 'transfer', category: '🚗 Auto loans', linkedTransferId: 522 },
      { id: 522, date: `${ym}-10 00:00:00.000`, amount: 234_468, transactionType: 'transfer', category: 'Uncategorized', linkedTransferId: 521 },
      // Genuine spending in the same category: a loan processing fee, AED 100.00.
      // Without it the guarded query would return 0 and "excludes transfers" would
      // be indistinguishable from "matches nothing".
      { id: 530, date: `${ym}-12 00:00:00.000`, amount: -10_000, transactionType: 'debit', category: '🚗 Auto loans', linkedTransferId: null },
    ]
    for (const r of rows) insert.run(r)
  })

  afterAll(() => db.close())

  it('the two legs do not cancel, which is what makes this worse than the double-count', () => {
    // The premise. In the PR #32 shape a transfer pair sums to zero and the tell
    // is arithmetic; here the filter only ever sees one leg.
    const bothLegs = db
      .prepare(`SELECT SUM(amount) AS net FROM "Transaction" WHERE transactionType = 'transfer'`)
      .get() as { net: number }
    expect(bothLegs.net).toBe(0)

    const filtered = db
      .prepare(`SELECT SUM(amount) AS net FROM "Transaction" WHERE category = '🚗 Auto loans' AND transactionType = 'transfer'`)
      .get() as { net: number }
    expect(filtered.net).toBe(-234_468)
  })

  it('the guarded query returns only real spending in the category', () => {
    const out = db.prepare(GUARDED).get() as { total: number }
    expect(out.total).toBe(-100)
    // The load-bearing assertion: AED 2,344.68 of moved money is not spending, so
    // the outflow stays smaller in magnitude than the repayment.
    expect(Math.abs(out.total)).toBeLessThan(2_344.68)
  })

  it('dropping the guard reports the whole repayment as spending', () => {
    const out = db.prepare(UNGUARDED).get() as { total: number }
    expect(out.total).toBe(-2_444.68)
    // Twenty-four times the real figure, well-formed, and narratable without a
    // hint that anything is wrong. This is the number the shape used to teach.
    expect(Math.abs(out.total)).toBeGreaterThan(20 * 100)
  })

  it('no guard in the chain refuses either shape — the protection is the prompt', () => {
    // Stated as a passing assertion rather than a comment, because it is the
    // ticket's "explicitly NOT in scope" item made checkable. If someone adds a
    // detector for this to lib/chatMoneyGuards.ts, this test goes red and points
    // at ADR-0016/0019 before the mirror case starts being refused in the app.
    expect(runGuardChain('How much did I spend on Auto loans?', GUARDED)).toBeNull()
    expect(runGuardChain('How much did I spend on Auto loans?', UNGUARDED)).toBeNull()
    expect(signBranchGuardViolation(UNGUARDED)).toBeNull()
    expect(transferSumViolation(UNGUARDED)).toBeNull()
  })

  it('MIRROR CASE (prompt-only, expected fragile): a loan-repayment question wants those rows', () => {
    // @qa — flagged, not pinned. "How much did I pay on my car loan" is answered
    // by the UNGUARDED shape: the transfer legs are the subject. Nothing in code
    // produces that shape; only the mirror-case prose in lib/chatSqlPrompt.ts
    // pulls the guard back off, and the model may well ignore it. Treat a failure
    // in the app as a prompt regression to investigate, not as a broken invariant.
    const paid = db.prepare(UNGUARDED).get() as { total: number }
    expect(paid.total).toBe(-2_444.68)

    // The whole reason for prompt-only: identical SQL, opposite intents, and the
    // guard chain cannot separate them because the difference is in the question.
    // Neither question is a balance question either, so ADR-0015's pre-check —
    // the one mechanism that DOES read the question — is silent on both.
    expect(runGuardChain('How much did I pay on my car loan?', UNGUARDED)).toBeNull()
    expect(balanceIntentMatch('How much did I spend on Auto loans?')).toBeNull()
    expect(balanceIntentMatch('How much did I pay on my car loan?')).toBeNull()
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
    [
      'sign split with no transactionType guard',
      'what did I earn and spend?',
      'SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income FROM "Transaction"',
      'unsupported-shape',
    ],
    [
      'naive transfer sum',
      'how much did I move between accounts?',
      "SELECT SUM(amount) AS total FROM \"Transaction\" WHERE transactionType = 'transfer'",
      'unsupported-shape',
    ],
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
// FORMERLY KNOWN GAPS — closed 2026-08-01.
//
// These two arrived as `it.fails` tripwires: two of the ticket's "must be
// declined" fixtures that did not decline. They are now plain `it` blocks
// because the behaviour they describe is real. The comments are kept as written
// so the shape of each bug survives its fix — the ticket's acceptance criteria,
// now met.
//
// GAP 1 was closed by moving ADR-0010's enforcement point onto result-row keys
// (lib/chatBalanceScope.ts § balanceScopeRowViolation), not by banning SELECT *
// in the SQL text. GAP 2 was closed by lib/chatAccountVocabulary.ts, ADR-0008's
// mechanism applied to Account.name.
// ─────────────────────────────────────────────────────────────────────────────
describe('closed gaps (were tripwires — keep them passing)', () => {
  it('GAP 1: `SELECT *` whose result rows carry openingBalance is declined', () => {
    // The ticket calls this out explicitly: "text-matching the query alone won't
    // catch it". balanceScopeViolation reads the SQL string, and this string
    // never contains the word — the column arrives via the star expansion. So
    // the check that catches it is the one that reads result-row KEYS, which is
    // the same thing narration reads.
    const sql = "SELECT * FROM Account WHERE type = 'liability'"

    // Proof the column really does arrive:
    const db = new Database(':memory:')
    db.exec('CREATE TABLE Account (id INTEGER PRIMARY KEY, name TEXT, type TEXT, openingBalance INTEGER)')
    db.prepare("INSERT INTO Account VALUES (1, 'Car loan', 'liability', -7034_04)").run()
    const rows = db.prepare(sql).all() as Array<Record<string, unknown>>
    db.close()
    expect(Object.keys(rows[0])).toContain('openingBalance')

    // The pre-execution text checks still can't see it — that is the whole
    // premise, and it must stay true or the fix is being credited to the wrong
    // mechanism.
    expect(balanceScopeViolation(sql)).toBeNull()

    // ...and this is what should happen, and now does:
    const outcome = runGuardChain('show me my loan accounts', sql, { rows })
    expect(outcome).not.toBeNull()
    expect(outcome!.guard).toBe('balance-scope-rows')
    expect(outcome!.reason).toBe('out-of-scope')
    expect(outcome!.detail).toBe('openingBalance')
    // Legible, and it does not pretend the query never ran (ADR-0014).
    expect(outcome!.message).toMatch(/openingBalance/)
    expect(outcome!.message).toMatch(/dashboard/i)
  })

  it("GAP 2: Account.name LIKE '%credit card%' matching nothing is declined", () => {
    // Session 10's predicate. ADR-0008's grounding was extended to account names
    // by the [chat-sql] 2 ticket's scope call, but the implementation shipped
    // categories only — lib/chatCategoryVocabulary.ts said so in its header
    // ("Scope is categories only"). An account-name guess that matches no stored
    // account used to run clean and return an empty result, which is the exact
    // false-"no data" shape ADR-0008 was written to stop.
    const sql =
      'SELECT a.name, SUM(t.amount) / 100.0 AS total FROM "Transaction" t ' +
      'JOIN Account a ON a.id = t.accountId ' +
      "WHERE a.name LIKE '%credit card%' GROUP BY a.name"

    const outcome = runGuardChain('what did I put on the credit card?', sql)
    expect(outcome).not.toBeNull()
    expect(outcome!.guard).toBe('account-vocabulary')
    expect(outcome!.reason).toBe('out-of-scope')
    // Reported as written, wildcards and all — same as the category guard does.
    // The refusal quotes what the model actually asked for, not a tidied version.
    expect(outcome!.detail).toBe('%credit card%')
    // Same bar as the category refusal: deny the empty result explicitly rather
    // than let it read as "nothing was spent".
    expect(outcome!.message).toMatch(/not the same as nothing having happened/i)
    // And it must be a dead end no longer — the real account names are offered.
    expect(outcome!.message).toContain('Mashreq Neo Visa')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The two closures, exercised beyond their single fixture. Each new guard is a
// fresh chance to over-reject, and the canaries above only cover the shapes that
// existed when they were written.
// ─────────────────────────────────────────────────────────────────────────────
describe('GAP 1 closure — result-row balance scope', () => {
  it('a star projection over a table with no sensitive column is left alone', () => {
    // The reason this is a row check and not a SELECT * ban: "show me my recent
    // transactions" is an ordinary question and an ordinary star projection.
    const rows = [{ id: 1, date: '2026-07-02', amount: -12_000, category: '🛒 Groceries' }]
    expect(runGuardChain('show me my recent transactions', 'SELECT * FROM "Transaction" LIMIT 20', { rows }))
      .toBeNull()
  })

  it('an ordinary aggregate result set is left alone', () => {
    expect(balanceScopeRowViolation([{ total: 260 }, { total: null }])).toBeNull()
  })

  it('an empty result set has no keys, so the check is a no-op', () => {
    expect(balanceScopeRowViolation([])).toBeNull()
  })

  it('scans every row, not just the first, so a sparse first row is not a hole', () => {
    // better-sqlite3 gives uniform keys, but that is the driver's property and
    // not this guard's, and a guard with a silent hole is the failure mode the
    // whole initiative keeps rediscovering.
    const rows = [{ total: 1 }, { total: 2, openingBalance: -703_404 }]
    expect(balanceScopeRowViolation(rows)).toEqual({
      kind: 'result-opening-balance',
      column: 'openingBalance',
    })
  })

  it('a returned column claiming balance semantics is caught alongside openingBalance', () => {
    // One scope decision, two enforcement points — the row check applies the
    // same alias vocabulary ADR-0010 applies to the SQL text.
    expect(balanceScopeRowViolation([{ account: 'Car loan', lastReconciledBalance: -703_404 }]))
      .toEqual({ kind: 'result-balance-alias', column: 'lastReconciledBalance', word: 'balance' })
  })

  it('case variants of the column name are caught (OPENING_BALANCE_RE style)', () => {
    for (const column of ['openingBalance', 'opening_balance', 'OPENINGBALANCE', 'a_opening_Balance']) {
      expect(balanceScopeRowViolation([{ [column]: 0 }]), column).not.toBeNull()
    }
  })
})

describe('GAP 2 closure — account-name grounding', () => {
  it('a grounded account name, copied exactly, passes', () => {
    const sql =
      'SELECT SUM(t.amount) / 100.0 AS total FROM "Transaction" t ' +
      "JOIN Account a ON a.id = t.accountId WHERE a.name = 'ADCB Current'"
    expect(runGuardChain('what went through my ADCB account?', sql)).toBeNull()
  })

  it('a LIKE fragment that really does occur in a stored name passes', () => {
    const sql =
      'SELECT SUM(t.amount) / 100.0 AS total FROM "Transaction" t ' +
      "JOIN Account a ON a.id = t.accountId WHERE a.name LIKE '%NBD%'"
    expect(runGuardChain('what went through NBD?', sql)).toBeNull()
  })

  it('a query joining Account but filtering on accountType is not judged', () => {
    // Filtering on the type rather than the name is the correct way to ask a
    // question about a class of account, and the prompt says so. Refusing it
    // would be over-rejection of the shape we are asking the model to produce.
    const sql =
      'SELECT a.accountType, SUM(t.amount) / 100.0 AS total FROM "Transaction" t ' +
      "JOIN Account a ON a.id = t.accountId WHERE a.accountType = 'credit' GROUP BY a.accountType"
    expect(runGuardChain('what did I put on cards?', sql)).toBeNull()
  })

  it("Category.name is not mistaken for Account.name", () => {
    // The reason the qualifier is resolved rather than assumed: `name` is not a
    // distinctive column the way `category` is, and a literal that is a category
    // name would be refused as a nonexistent account if this were sloppy.
    const sql =
      'SELECT c.name, COUNT(*) AS n FROM "Transaction" t ' +
      "JOIN Category c ON c.name = t.category WHERE c.name = '✈️ Travel' GROUP BY c.name"
    expect(runGuardChain('how many travel transactions?', sql)).toBeNull()
  })

  it('a bare `name` is judged when Account is the only table read', () => {
    const sql = "SELECT id FROM Account WHERE name = 'Chase Sapphire'"
    const outcome = runGuardChain('show me my Chase account', sql)
    expect(outcome).not.toBeNull()
    expect(outcome!.guard).toBe('account-vocabulary')
    expect(outcome!.detail).toBe('Chase Sapphire')
  })

  it('a bare `name` in a joined query is ambiguous and deliberately not judged', () => {
    // The chosen failure mode, stated: an unrecognised shape is not checked, the
    // query runs, and a genuine miss still lands on ADR-0014's `no-data` refusal
    // rather than a narrated zero. Guessing here would risk refusing a legitimate
    // Category.name filter.
    const sql =
      'SELECT name FROM "Transaction" t JOIN Account ON Account.id = t.accountId ' +
      "WHERE name = 'Chase Sapphire'"
    expect(runGuardChain('show me my Chase account', sql)).toBeNull()
  })

  it('an IN list refuses on the members that are not stored', () => {
    const sql =
      'SELECT a.name, SUM(t.amount) / 100.0 AS total FROM "Transaction" t ' +
      "JOIN Account a ON a.id = t.accountId WHERE a.name IN ('ADCB Current', 'Barclays Everyday') GROUP BY a.name"
    const outcome = runGuardChain('split by account', sql)
    expect(outcome).not.toBeNull()
    expect(outcome!.detail).toBe('Barclays Everyday')
  })

  it('with no stored accounts, nothing is judged', () => {
    const sql =
      'SELECT SUM(t.amount) AS total FROM "Transaction" t ' +
      "JOIN Account a ON a.id = t.accountId WHERE a.name = 'Anything'"
    expect(runGuardChain('total on Anything', sql, { accounts: [] })).toBeNull()
  })

  it('the existing canaries are untouched by the account guard', () => {
    // Order-independence again: no canary filters on an account name, so adding
    // a guard that only looks at account-name predicates must change nothing.
    for (const [label, , sql] of CANARIES) {
      expect(unknownAccountLiterals(sql, ACCOUNTS), label).toEqual([])
    }
  })
})
