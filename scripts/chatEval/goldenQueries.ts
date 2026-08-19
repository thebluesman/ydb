/**
 * [chat-eval] golden-query set: ~25 natural-language question -> expected-
 * result pairs, run against the fixture ledger (fixtureDb.ts).
 *
 * Expected values are computed by a `groundTruth` SQL query against the
 * fixture DB, not hand-typed numbers — auditing one obviously-correct SQL
 * statement per fixture is safer than trusting mental arithmetic over ~20
 * rows, and it's self-documenting: the ground-truth query IS the
 * specification of what "correct" means for that question.
 *
 * Coverage target, per the ticket: integer cents vs dollars, split-leg
 * double-counting, reimbursement netting, plus general aggregate correctness
 * and the refusal paths (balance questions, unmatched categories).
 */

import type { Database as Db } from 'better-sqlite3'

export type Expectation =
  | { kind: 'value'; sql: string; tolerance?: number; signInsensitive?: boolean }
  | { kind: 'count'; sql: string }
  | { kind: 'refusal' }
  | { kind: 'value-or-refusal'; sql: string; tolerance?: number; signInsensitive?: boolean }

export type GoldenQuery = {
  id: string
  question: string
  history?: { role: 'user' | 'assistant'; text: string }[]
  expect: Expectation
  /** Why this fixture exists — the trap or behavior it's checking. */
  note: string
}

export const GOLDEN_QUERIES: GoldenQuery[] = [
  {
    id: 'groceries-last-month',
    question: 'How much did I spend on groceries last month?',
    expect: {
      kind: 'value',
      signInsensitive: true,
      sql: `SELECT SUM(amount)/100.0 AS total FROM "Transaction" WHERE category = 'Groceries' AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = '2026-07'`,
    },
    note: 'Basic category aggregate, integer-cents-to-dollars conversion.',
  },
  {
    id: 'dining-last-month',
    question: 'How much did I spend on dining last month?',
    expect: {
      kind: 'value',
      signInsensitive: true,
      sql: `SELECT SUM(amount)/100.0 AS total FROM "Transaction" WHERE category = 'Dining' AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = '2026-07'`,
    },
    note: 'Spans two accounts (Main Checking + Rewards Card); no account filter in the question.',
  },
  {
    id: 'rent-last-month',
    question: 'What was my rent last month?',
    expect: {
      kind: 'value',
      signInsensitive: true,
      sql: `SELECT SUM(amount)/100.0 AS total FROM "Transaction" WHERE category = 'Rent' AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = '2026-07'`,
    },
    note: 'Single-row category, sanity baseline.',
  },
  {
    id: 'shopping-split-leg',
    question: 'How much did I spend on shopping last month?',
    expect: {
      kind: 'value',
      signInsensitive: true,
      sql: `SELECT SUM(amount)/100.0 AS total FROM "Transaction" WHERE category = 'Shopping' AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = '2026-07'`,
    },
    note: 'SPLIT-LEG TRAP. The parent (-$200) already equals the sum of its two legs. A query that counts both the parent and its legs is wrong by exactly the leg total (would report -$400 instead of -$200).',
  },
  {
    id: 'travel-reimbursement-netting',
    question: 'How much did I spend on travel last month?',
    expect: {
      kind: 'value',
      signInsensitive: true,
      sql: `SELECT SUM(amount)/100.0 AS total FROM "Transaction" WHERE category = 'Travel' AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = '2026-07'`,
    },
    note: 'REIMBURSEMENT TRAP. A $300 client dinner was reimbursed and must be netted out via reimbursementTxId IS NULL, leaving only the unreimbursed $80 train ticket. A query that includes the reimbursed expense over-reports by $300.',
  },
  {
    id: 'total-income-reimbursement-aware',
    question: 'What was my total income last month?',
    expect: {
      kind: 'value',
      signInsensitive: false,
      sql: `SELECT SUM(amount)/100.0 AS total FROM "Transaction" WHERE amount > 0 AND transactionType != 'transfer' AND parentTransactionId IS NULL AND NOT EXISTS (SELECT 1 FROM "Transaction" x WHERE x.reimbursementTxId = "Transaction".id) AND strftime('%Y-%m', date) = '2026-07'`,
    },
    note: 'REIMBURSEMENT TRAP, income side. The $300 settlement credit is not real income and must be excluded via the NOT EXISTS half of the guard, matching the shipped two-figure worked example. A naive income query reports $5,300 instead of $5,000.',
  },
  {
    id: 'total-expenses-last-month',
    question: 'What were my total expenses last month?',
    expect: {
      kind: 'value',
      signInsensitive: true,
      sql: `SELECT SUM(amount)/100.0 AS total FROM "Transaction" WHERE amount < 0 AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = '2026-07'`,
    },
    note: 'General expense aggregate combining every guard at once: transfer exclusion, split-leg exclusion, reimbursement netting.',
  },
  {
    id: 'transfer-volume-non-cancellation',
    question: 'How much did I move between my accounts last month?',
    expect: {
      kind: 'value',
      signInsensitive: false,
      sql: `SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)/100.0 AS total FROM "Transaction" WHERE transactionType = 'transfer' AND strftime('%Y-%m', date) = '2026-07'`,
    },
    note: 'TRANSFER-CANCELLATION TRAP. A bare SUM(amount) over transfer rows cancels to ~0 by construction (all four transfer legs sum to exactly zero) however much was actually moved ($1,500). Only summing the positive legs gives the real volume.',
  },
  {
    id: 'car-loan-payment-transfer-mirror-case',
    question: 'How much did I pay on my car loan last month?',
    expect: {
      kind: 'value',
      signInsensitive: true,
      sql: `SELECT SUM(amount)/100.0 AS total FROM "Transaction" WHERE category = 'Auto Loan Payment' AND parentTransactionId IS NULL AND strftime('%Y-%m', date) = '2026-07'`,
    },
    note: 'MIRROR-CASE TRAP. The payment is stored as a transfer, and this question is specifically ABOUT that transfer, so transactionType != \'transfer\' must NOT be applied here (unlike every general spending question). Wrongly excluding it returns no-data instead of $500.',
  },
  {
    id: 'transaction-count',
    question: 'How many transactions do I have?',
    expect: {
      kind: 'count',
      sql: `SELECT COUNT(*) AS total FROM "Transaction" WHERE parentTransactionId IS NULL AND status IN ('committed','reconciled')`,
    },
    note: 'Split legs must not be double-counted as separate transactions.',
  },
  {
    id: 'account-filtered-category',
    question: 'How much did I spend on groceries on my Rewards Card last month?',
    expect: {
      kind: 'value',
      signInsensitive: true,
      sql: `SELECT SUM(t.amount)/100.0 AS total FROM "Transaction" t JOIN Account a ON t.accountId = a.id WHERE a.name = 'Rewards Card' AND t.category = 'Groceries' AND t.transactionType != 'transfer' AND t.parentTransactionId IS NULL AND t.reimbursementTxId IS NULL AND strftime('%Y-%m', t.date) = '2026-07'`,
    },
    note: 'Account name + category filter combined, requires a JOIN with a qualified name predicate.',
  },
  {
    id: 'this-month-income',
    question: "What's my total income this month?",
    expect: {
      kind: 'value',
      signInsensitive: false,
      sql: `SELECT SUM(amount)/100.0 AS total FROM "Transaction" WHERE amount > 0 AND transactionType != 'transfer' AND parentTransactionId IS NULL AND strftime('%Y-%m', date) = '2026-08'`,
    },
    note: '"This month" (partial, up to the reference date) rather than "last month" — date-window correctness.',
  },
  {
    id: 'balance-question-refused',
    question: "What's my Main Checking account balance?",
    expect: { kind: 'refusal' },
    note: 'Balance/net-worth questions are declared out of scope (ADR-0009/0010/0015) — must refuse, never approximate with a flow sum.',
  },
  {
    id: 'owed-question-refused',
    question: 'How much do I still owe on my car loan?',
    expect: { kind: 'refusal' },
    note: 'Same balance-scope refusal, phrased as "owe" rather than "balance".',
  },
  {
    id: 'unmatched-category-refused',
    question: 'How much did I spend on Pizza last month?',
    expect: { kind: 'refusal' },
    note: 'ADR-0008 category grounding: "Pizza" is not in the fixture vocabulary, must refuse rather than silently return $0.',
  },
  {
    id: 'rent-this-year',
    question: 'How much did I spend on rent this year?',
    expect: {
      kind: 'value',
      signInsensitive: true,
      sql: `SELECT SUM(amount)/100.0 AS total FROM "Transaction" WHERE category = 'Rent' AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y', date) = '2026'`,
    },
    note: 'Wider date window spanning both July and August rows.',
  },
  {
    id: 'groceries-transaction-count',
    question: 'How many grocery transactions did I have last month?',
    expect: {
      kind: 'count',
      sql: `SELECT COUNT(*) AS total FROM "Transaction" WHERE category = 'Groceries' AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = '2026-07'`,
    },
    note: 'COUNT rather than SUM — must not be treated as a money value (no /100 division).',
  },
  {
    id: 'average-grocery-transaction',
    question: 'What was my average grocery transaction last month?',
    expect: {
      kind: 'value',
      signInsensitive: true,
      tolerance: 0.02,
      sql: `SELECT AVG(amount)/100.0 AS average_transaction FROM "Transaction" WHERE category = 'Groceries' AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = '2026-07'`,
    },
    note: 'AVG() aggregate — exercises the money-units classifier\'s aggregate-wrapper resolution (ADR-0020) on a function other than SUM. Aliased average_transaction, not total: scripts/evalChatVerifier.ts reuses this ground-truth SQL as a GOOD case, and an average aliased total is a genuine name/expression contradiction that the LABEL check is right to flag (ADR-0031 review, 2026-08-18). Both readers of this SQL take the value positionally, so the alias text is free to be accurate.',
  },
  {
    id: 'income-and-expenses-together',
    question: 'What was my income and my expenses last month?',
    expect: {
      kind: 'value',
      signInsensitive: false,
      sql: `SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)/100.0 AS total_income FROM "Transaction" WHERE transactionType != 'transfer' AND parentTransactionId IS NULL AND NOT EXISTS (SELECT 1 FROM "Transaction" x WHERE x.reimbursementTxId = "Transaction".id) AND strftime('%Y-%m', date) = '2026-07'`,
    },
    note: 'Multi-figure question (ADR-0011): must be one row, two aliased columns, never a UNION. This checks the income half specifically since it is the more error-prone of the two.',
  },
  {
    id: 'percentage-of-spending-derived-ratio',
    question: 'What percentage of my spending last month was groceries?',
    expect: {
      kind: 'value-or-refusal',
      tolerance: 0.5,
      sql: `SELECT (SELECT SUM(amount) FROM "Transaction" WHERE category = 'Groceries' AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = '2026-07') * 100.0 / (SELECT SUM(amount) FROM "Transaction" WHERE amount < 0 AND transactionType != 'transfer' AND parentTransactionId IS NULL AND reimbursementTxId IS NULL AND strftime('%Y-%m', date) = '2026-07') AS total`,
    },
    note: 'DERIVED-RATIO TRAP, live-reproduced during the [chat-bug] re-scoping (2026-08-03): a percentage combining two aggregates is exactly the shape where a misplaced /100.0 silently computes a value ~100x off. ADR-0020\'s classifier does not and cannot catch this (it only checks for /100 presence, not placement) — this fixture is exactly the eval-harness material that finding called for. Expected ~11.08%.',
  },
  {
    id: 'no-transactions-this-category-no-data',
    question: 'How much did I spend on Groceries in January?',
    expect: { kind: 'refusal' },
    note: 'A grounded category with zero matching rows in the queried window must be a no-data non-answer, never a narrated "you spent $0".',
  },
  {
    id: 'household-split-leg-visibility',
    question: 'How much did I spend on household last month?',
    expect: { kind: 'refusal' },
    note: 'FOLLOWUPS.md §6: split legs\' individual categories (Household, here) are not surfaced by the default category-aggregate convention, which uses the parent\'s category (Shopping). "Household" is not in the vocabulary as a distinct top-level category presence for this ledger the way the model would need to answer directly, so a no-data/refusal is the documented-correct outcome, not a bug in the fixture.',
  },
]

/** Runs a fixture's ground-truth SQL against the fixture DB. */
export function groundTruthValue(db: Db, sql: string): number | null {
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined
  const value = row ? Object.values(row)[0] : null
  return typeof value === 'number' ? value : null
}
