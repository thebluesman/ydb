import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'
import { validateTransactionWrite } from '@/lib/transactionValidation'

const INCLUDE = {
  account: { select: { name: true, currency: true } },
  splitLegs: { select: { id: true, amount: true, category: true, description: true } },
  reimbursementTx: { select: { id: true, amount: true, description: true } },
  reimbursedExpense: { select: { id: true, description: true } },
  transferCounterpartAccount: { select: { id: true, name: true } },
} as const

export async function POST(request: Request) {
  const body: {
    date: string
    amount: number
    description: string
    transactionType: string
    category: string
    accountId: number
    notes?: string
    status?: string
    transferCounterpartAccountId?: number | null
  } = await request.json()

  if (!body.date || body.amount === undefined || !body.description || !body.accountId) {
    return NextResponse.json({ error: 'date, amount, description, and accountId are required' }, { status: 400 })
  }

  const invalid = await validateTransactionWrite({
    transactionType: body.transactionType,
    amount: body.amount,
    accountId: body.accountId,
    transferCounterpartAccountId: body.transferCounterpartAccountId ?? null,
  })
  if (invalid) return NextResponse.json(invalid, { status: 400 })

  const isTransferPair =
    body.transactionType === 'transfer' &&
    body.transferCounterpartAccountId != null &&
    body.transferCounterpartAccountId !== body.accountId

  const sharedFields = {
    date: new Date(body.date),
    description: body.description,
    transactionType: body.transactionType ?? (body.amount >= 0 ? 'credit' : 'debit'),
    category: body.category ?? '',
    notes: body.notes ?? null,
    status: body.status ?? 'committed',
  }

  // Non-transfer (or transfer without a counterpart): one-row create, same as before.
  if (!isTransferPair) {
    const transaction = await prisma.transaction.create({
      data: {
        ...sharedFields,
        amount: body.amount,
        accountId: body.accountId,
        transferCounterpartAccountId: body.transferCounterpartAccountId ?? null,
      },
      include: INCLUDE,
    })
    return NextResponse.json(transaction)
  }

  // Two-sided transfer: create both rows atomically and cross-link so a later
  // delete/patch on either side can keep them in sync. Counterpart row gets
  // the opposite sign so Σamount for each account reflects the real movement.
  const counterpartId = body.transferCounterpartAccountId!
  const created = await prisma.$transaction(async (tx) => {
    const side1 = await tx.transaction.create({
      data: {
        ...sharedFields,
        amount: body.amount,
        accountId: body.accountId,
        transferCounterpartAccountId: counterpartId,
      },
    })
    const side2 = await tx.transaction.create({
      data: {
        ...sharedFields,
        amount: -body.amount,
        accountId: counterpartId,
        transferCounterpartAccountId: body.accountId,
        linkedTransferId: side1.id,
      },
    })
    await tx.transaction.update({
      where: { id: side1.id },
      data: { linkedTransferId: side2.id },
    })
    return side1.id
  })

  const result = await prisma.transaction.findUnique({
    where: { id: created },
    include: INCLUDE,
  })
  return NextResponse.json(result)
}
