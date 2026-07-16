// Reconciliation flow (IMPROVEMENT_PLAN Phase 7 item 2).
//
// The `reconciled` transaction status already exists; this module computes
// the "what the app thinks your balance is on date X" figure the user
// compares against a bank statement, entirely in terms of the canonical
// balance rules in lib/accounts.ts (asset: opening + sum; liability:
// opening − sum). All amounts are integer cents.

import { computeBalance } from './accounts'

export type ReconcileAccount = { accountType: string; openingBalance: number }

/**
 * Balance the app computes as of `asOfDate` (inclusive), from committed +
 * reconciled transactions only — `review` rows are unconfirmed and excluded,
 * matching the invariant that only committed/reconciled rows count toward
 * balances elsewhere (dashboard, ledger stats).
 */
export function computeBalanceAsOf(account: ReconcileAccount, txSumThroughDate: number): number {
  return computeBalance(account, txSumThroughDate)
}

export type ReconcileResult = {
  computedBalance: number
  statementBalance: number
  delta: number       // statementBalance - computedBalance, in cents
  balanced: boolean
}

export function evaluateReconciliation(
  account: ReconcileAccount,
  txSumThroughDate: number,
  statementBalanceCents: number,
): ReconcileResult {
  const computedBalance = computeBalanceAsOf(account, txSumThroughDate)
  const delta = statementBalanceCents - computedBalance
  return { computedBalance, statementBalance: statementBalanceCents, delta, balanced: delta === 0 }
}

/** SQL for the signed sum of committed+reconciled transactions on one account
 *  up to and including `throughIso` (an end-of-day ISO string). Excludes
 *  nothing else — reconciliation deliberately looks at the raw ledger, not
 *  the dashboard's split/reimbursement display rules, since a bank statement
 *  reflects every posted row. */
export function accountTxSumThroughDateSql(accountId: number, throughIso: string): string {
  if (!Number.isInteger(accountId)) throw new Error('accountId must be an integer')
  return (
    `SELECT COALESCE(SUM(amount), 0) AS s FROM "Transaction"` +
    ` WHERE accountId = ${accountId} AND status IN ('committed','reconciled')` +
    ` AND date <= '${throughIso}'`
  )
}

/** SQL to mark committed rows on one account, up to and including
 *  `throughIso`, as reconciled. Only flips `status = 'committed'` rows —
 *  already-`reconciled` rows are untouched (idempotent re-run) and `review`
 *  rows are never silently promoted. */
export function markReconciledSql(accountId: number, throughIso: string): string {
  if (!Number.isInteger(accountId)) throw new Error('accountId must be an integer')
  return (
    `UPDATE "Transaction" SET status = 'reconciled'` +
    ` WHERE accountId = ${accountId} AND status = 'committed' AND date <= '${throughIso}'`
  )
}
