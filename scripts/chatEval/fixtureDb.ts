/**
 * A small, hand-crafted ledger for the [chat-eval] golden-query harness.
 *
 * Deliberately NOT prisma/dev.db: the eval needs exact, reproducible expected
 * answers, and a real ledger changes underneath you. Schema mirrors
 * prisma/schema.prisma's Account and Transaction models closely enough for
 * every chat-path guard and vocabulary loader to run against it unmodified —
 * only the columns those actually touch are included.
 *
 * "Today" is pinned to REFERENCE_NOW (2026-08-03) rather than `new Date()`, so
 * "last month" / "this month" / "this year" resolve to the same real dates on
 * every run regardless of when the eval is actually executed.
 */

import Database from 'better-sqlite3'
import type { Database as Db } from 'better-sqlite3'

export const REFERENCE_NOW = new Date('2026-08-03T12:00:00.000Z')

export type FixtureAccount = {
  id: number
  name: string
  accountType: string
  creditLimit: number | null
}

export type FixtureTransaction = {
  id: number
  date: string // 'YYYY-MM-DD HH:MM:SS.mmm', matching the real app's stored format
  amount: number // integer cents
  description: string
  transactionType: 'debit' | 'credit' | 'transfer'
  category: string
  accountId: number
  status: 'committed'
  linkedTransferId?: number | null
  parentTransactionId?: number | null
  reimbursementTxId?: number | null
}

export const ACCOUNTS: FixtureAccount[] = [
  { id: 1, name: 'Main Checking', accountType: 'current', creditLimit: null },
  { id: 2, name: 'Rewards Card', accountType: 'credit', creditLimit: 500_000 },
  { id: 3, name: 'Car Loan', accountType: 'auto_loan', creditLimit: null },
  { id: 4, name: 'Emergency Savings', accountType: 'savings', creditLimit: null },
]

// All cents. Dates fall in July 2026 ("last month" relative to REFERENCE_NOW)
// and the first three days of August 2026 ("this month").
export const TRANSACTIONS: FixtureTransaction[] = [
  { id: 101, date: '2026-07-05 00:00:00.000', amount: -12_000, description: 'Whole Foods', transactionType: 'debit', category: 'Groceries', accountId: 1, status: 'committed' },
  { id: 102, date: '2026-07-12 00:00:00.000', amount: -8_500, description: 'Trader Joes', transactionType: 'debit', category: 'Groceries', accountId: 1, status: 'committed' },
  { id: 103, date: '2026-07-15 00:00:00.000', amount: -4_500, description: 'Bistro', transactionType: 'debit', category: 'Dining', accountId: 1, status: 'committed' },
  { id: 104, date: '2026-07-01 00:00:00.000', amount: -150_000, description: 'Rent', transactionType: 'debit', category: 'Rent', accountId: 1, status: 'committed' },
  { id: 105, date: '2026-07-01 00:00:00.000', amount: 500_000, description: 'Salary', transactionType: 'credit', category: 'Salary', accountId: 1, status: 'committed' },

  // Pure transfer, no spend category on either leg — Main Checking -> Emergency Savings.
  { id: 106, date: '2026-07-10 00:00:00.000', amount: -100_000, description: 'Transfer to savings', transactionType: 'transfer', category: 'Uncategorized', accountId: 1, status: 'committed', linkedTransferId: 107 },
  { id: 107, date: '2026-07-10 00:00:00.000', amount: 100_000, description: 'Transfer from checking', transactionType: 'transfer', category: 'Uncategorized', accountId: 4, status: 'committed', linkedTransferId: 106 },

  // Transfer whose OUTGOING leg carries a real spend category (ADR-0019 shape) —
  // Main Checking -> Car Loan, a loan repayment.
  { id: 108, date: '2026-07-20 00:00:00.000', amount: -50_000, description: 'Car loan payment', transactionType: 'transfer', category: 'Auto Loan Payment', accountId: 1, status: 'committed', linkedTransferId: 109 },
  { id: 109, date: '2026-07-20 00:00:00.000', amount: 50_000, description: 'Payment received', transactionType: 'transfer', category: 'Uncategorized', accountId: 3, status: 'committed', linkedTransferId: 108 },

  // Split transaction. Parent keeps its pre-split category ('Shopping') per
  // this app's convention (app/api/transactions/[id]/split/route.ts never
  // touches parent.category) — FOLLOWUPS.md §6 documents that a category
  // aggregate uses the parent's category, not the legs'. The point of this
  // fixture is double-counting: parent.amount already equals the legs' sum,
  // so a query that includes both is wrong by exactly the leg total.
  { id: 110, date: '2026-07-22 00:00:00.000', amount: -20_000, description: 'Target run', transactionType: 'debit', category: 'Shopping', accountId: 1, status: 'committed' },
  { id: 111, date: '2026-07-22 00:00:00.000', amount: -15_000, description: 'Target run', transactionType: 'debit', category: 'Groceries', accountId: 1, status: 'committed', parentTransactionId: 110 },
  { id: 112, date: '2026-07-22 00:00:00.000', amount: -5_000, description: 'Target run', transactionType: 'debit', category: 'Household', accountId: 1, status: 'committed', parentTransactionId: 110 },

  // Reimbursed expense + its settlement credit.
  { id: 113, date: '2026-07-25 00:00:00.000', amount: -30_000, description: 'Client dinner', transactionType: 'debit', category: 'Travel', accountId: 1, status: 'committed', reimbursementTxId: 114 },
  { id: 114, date: '2026-07-28 00:00:00.000', amount: 30_000, description: 'Expense reimbursement', transactionType: 'credit', category: 'Uncategorized', accountId: 1, status: 'committed' },

  // An unreimbursed travel expense, so "travel spend" isn't a trivial zero.
  { id: 118, date: '2026-07-18 00:00:00.000', amount: -8_000, description: 'Train ticket', transactionType: 'debit', category: 'Travel', accountId: 1, status: 'committed' },

  // August (partial month, "this month" as of REFERENCE_NOW).
  { id: 115, date: '2026-08-01 00:00:00.000', amount: -150_000, description: 'Rent', transactionType: 'debit', category: 'Rent', accountId: 1, status: 'committed' },
  { id: 116, date: '2026-08-01 00:00:00.000', amount: 500_000, description: 'Salary', transactionType: 'credit', category: 'Salary', accountId: 1, status: 'committed' },
  { id: 117, date: '2026-08-02 00:00:00.000', amount: -6_000, description: 'Corner store', transactionType: 'debit', category: 'Groceries', accountId: 1, status: 'committed' },

  // Rewards Card — for account-filtered questions.
  { id: 201, date: '2026-07-08 00:00:00.000', amount: -6_000, description: 'Steakhouse', transactionType: 'debit', category: 'Dining', accountId: 2, status: 'committed' },
  { id: 202, date: '2026-07-19 00:00:00.000', amount: -3_000, description: 'Corner store', transactionType: 'debit', category: 'Groceries', accountId: 2, status: 'committed' },
]

export function buildFixtureDb(): Db {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE Account (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      accountType TEXT NOT NULL,
      creditLimit INTEGER
    );
    CREATE TABLE "Transaction" (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      amount INTEGER NOT NULL,
      description TEXT NOT NULL,
      transactionType TEXT NOT NULL,
      category TEXT NOT NULL,
      accountId INTEGER NOT NULL,
      status TEXT NOT NULL,
      linkedTransferId INTEGER,
      parentTransactionId INTEGER,
      reimbursementTxId INTEGER
    );
  `)

  const insertAccount = db.prepare(
    `INSERT INTO Account (id, name, accountType, creditLimit) VALUES (@id, @name, @accountType, @creditLimit)`,
  )
  for (const a of ACCOUNTS) insertAccount.run(a)

  const insertTxn = db.prepare(`
    INSERT INTO "Transaction"
      (id, date, amount, description, transactionType, category, accountId, status,
       linkedTransferId, parentTransactionId, reimbursementTxId)
    VALUES
      (@id, @date, @amount, @description, @transactionType, @category, @accountId, @status,
       @linkedTransferId, @parentTransactionId, @reimbursementTxId)
  `)
  for (const t of TRANSACTIONS) {
    insertTxn.run({
      linkedTransferId: null,
      parentTransactionId: null,
      reimbursementTxId: null,
      ...t,
    })
  }

  return db
}

/** Minimal prisma-shaped source for loadCategoryVocabulary, backed by the fixture DB. */
export function fixtureCategorySource(db: Db) {
  return {
    transaction: {
      findMany: async () =>
        (db.prepare(`SELECT DISTINCT category FROM "Transaction"`).all() as { category: string }[]),
    },
  }
}

/** Minimal prisma-shaped source for loadAccountVocabulary, backed by the fixture DB. */
export function fixtureAccountSource(db: Db) {
  return {
    account: {
      findMany: async () =>
        (db.prepare(`SELECT name FROM Account ORDER BY name ASC`).all() as { name: string | null }[]),
    },
  }
}
