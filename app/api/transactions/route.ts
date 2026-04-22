import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'
import { validateTransactionWrite } from '@/lib/transactionValidation'

export async function GET() {
  const transactions = await prisma.transaction.findMany({
    orderBy: { date: 'desc' },
    include: {
      account: { select: { name: true, currency: true } },
      splitLegs: { select: { id: true, amount: true, category: true, description: true } },
      reimbursementTx: { select: { id: true, amount: true, description: true } },
      reimbursedExpense: { select: { id: true, description: true } },
      transferCounterpartAccount: { select: { id: true, name: true } },
    },
  })
  return NextResponse.json(transactions)
}

type IncomingTx = {
  date: string
  amount: number
  description: string
  originalDescription?: string
  transactionType: string
  category: string
  accountId: number
  notes?: string
  rawSource?: string
  status?: string
  transferCounterpartAccountId?: number | null
}

export async function POST(request: Request) {
  const body: Array<IncomingTx> = await request.json()

  if (!Array.isArray(body) || body.length === 0) {
    return NextResponse.json({ error: 'Expected non-empty array of transactions' }, { status: 400 })
  }

  // Validate each row up front. Imports are one-sided by nature so transfers
  // without a counterpart are allowed. Any other violation (wrong sign for
  // the declared type, self-transfer, cross-currency transfer) rejects the
  // whole batch so the user can fix the source and retry atomically.
  for (let i = 0; i < body.length; i++) {
    const row = body[i]
    const invalid = await validateTransactionWrite(
      {
        transactionType: row.transactionType,
        amount: row.amount,
        accountId: row.accountId,
        transferCounterpartAccountId: row.transferCounterpartAccountId ?? null,
      },
      { allowOneSidedTransfer: true },
    )
    if (invalid) {
      return NextResponse.json({ ...invalid, row: i }, { status: 400 })
    }
  }

  // Statements only produce one side of a transfer per file, so transfers
  // in an import batch are normally one-row entries. When the caller sets
  // transferCounterpartAccountId we still trust a one-row insert for
  // backward compatibility (the statement being imported IS one side).
  // createMany handles the non-paired rows in a single round trip.
  const rows = body.map((t) => ({
    date: new Date(t.date),
    amount: t.amount,
    description: t.description,
    originalDescription: t.originalDescription ?? null,
    transactionType: t.transactionType ?? (t.amount >= 0 ? 'credit' : 'debit'),
    category: t.category ?? '',
    accountId: t.accountId,
    notes: t.notes ?? null,
    rawSource: t.rawSource ?? null,
    status: t.status ?? 'committed',
    transferCounterpartAccountId: t.transferCounterpartAccountId ?? null,
  }))

  const result = await prisma.transaction.createMany({ data: rows })
  return NextResponse.json({ count: result.count })
}
