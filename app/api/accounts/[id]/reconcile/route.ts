import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { toCents } from '@/lib/money'
import { toDbDate } from '@/lib/transactions-query'
import { evaluateReconciliation, accountTxSumThroughDateSql, markReconciledSql } from '@/lib/reconciliation'

// POST /api/accounts/[id]/reconcile
// body: { statementBalance: number (major units), date: string (yyyy-mm-dd), commit?: boolean }
//
// Always computes the app's balance through `date` from committed+reconciled
// rows and returns the delta against the statement balance. When `commit` is
// true AND the delta is exactly zero, also flips that period's committed rows
// to `reconciled` and records the account's last-reconciled checkpoint.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const accountId = parseInt(id, 10)
  if (!Number.isInteger(accountId)) {
    return NextResponse.json({ error: 'Invalid account id' }, { status: 400 })
  }

  const body = await request.json().catch(() => null)
  const statementBalanceRaw = body?.statementBalance
  const dateRaw = body?.date
  const commit = body?.commit === true
  if (typeof statementBalanceRaw !== 'number' || !Number.isFinite(statementBalanceRaw)) {
    return NextResponse.json({ error: 'statementBalance (number) is required' }, { status: 400 })
  }
  if (typeof dateRaw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateRaw) || isNaN(new Date(dateRaw).getTime())) {
    return NextResponse.json({ error: 'date (yyyy-mm-dd) is required' }, { status: 400 })
  }

  const account = await prisma.account.findUnique({ where: { id: accountId } })
  if (!account) {
    return NextResponse.json({ error: 'Account not found' }, { status: 404 })
  }

  // End-of-day in UTC, not the server's local timezone — matches the
  // convention lib/transactions-query.ts's ledger date-range filter uses
  // (new Date(`${date}T23:59:59.999Z`)), so "through 2026-07-16" means the
  // same UTC calendar day everywhere regardless of server locale.
  const asOf = new Date(`${dateRaw}T23:59:59.999Z`)
  const throughIso = toDbDate(asOf)

  const [sumRow] = await prisma.$queryRawUnsafe<{ s: number | bigint }[]>(
    accountTxSumThroughDateSql(accountId, throughIso),
  )
  const txSum = typeof sumRow?.s === 'bigint' ? Number(sumRow.s) : (sumRow?.s ?? 0)

  const statementBalanceCents = toCents(statementBalanceRaw)
  const result = evaluateReconciliation(
    { accountType: account.accountType, openingBalance: account.openingBalance },
    txSum,
    statementBalanceCents,
  )

  if (!commit || !result.balanced) {
    return NextResponse.json(result)
  }

  await prisma.$executeRawUnsafe(markReconciledSql(accountId, throughIso))
  await prisma.account.update({
    where: { id: accountId },
    data: { lastReconciledAt: asOf, lastReconciledBalance: statementBalanceCents },
  })

  return NextResponse.json({ ...result, committed: true })
}
