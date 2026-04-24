import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'

const INCLUDE = {
  account: { select: { name: true, currency: true } },
  splitLegs: { select: { id: true, amount: true, category: true, description: true } },
  reimbursementTx: { select: { id: true, amount: true, description: true } },
  reimbursedExpense: { select: { id: true, description: true } },
} as const

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const { targetId } = await request.json()
  const expenseId = parseInt(id)
  const settlementId = parseInt(targetId)
  if (isNaN(expenseId) || isNaN(settlementId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }
  if (expenseId === settlementId) {
    return NextResponse.json({ error: 'a transaction cannot reimburse itself' }, { status: 400 })
  }

  const [expense, settlement] = await Promise.all([
    prisma.transaction.findUnique({ where: { id: expenseId } }),
    prisma.transaction.findUnique({ where: { id: settlementId } }),
  ])
  if (!expense) return NextResponse.json({ error: 'expense not found' }, { status: 404 })
  if (!settlement) return NextResponse.json({ error: 'settlement not found' }, { status: 404 })

  if (expense.transactionType !== 'debit') {
    return NextResponse.json(
      { error: 'reimbursement target must be a debit (the out-of-pocket expense)' },
      { status: 400 },
    )
  }
  if (settlement.transactionType !== 'credit') {
    return NextResponse.json(
      { error: 'reimbursement settlement must be a credit (money received back)' },
      { status: 400 },
    )
  }
  // @unique on reimbursementTxId will catch this at write time; surface a
  // friendlier 409 first so the UI can show a proper message.
  const alreadyLinked = await prisma.transaction.findFirst({
    where: { reimbursementTxId: settlementId, NOT: { id: expenseId } },
    select: { id: true, description: true },
  })
  if (alreadyLinked) {
    return NextResponse.json(
      { error: `settlement is already reimbursing expense #${alreadyLinked.id} (${alreadyLinked.description})` },
      { status: 409 },
    )
  }

  await prisma.transaction.update({
    where: { id: expenseId },
    data: { reimbursementTxId: settlementId },
  })

  const updated = await prisma.transaction.findUnique({
    where: { id: expenseId },
    include: INCLUDE,
  })
  return NextResponse.json(updated)
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const expenseId = parseInt(id)
  if (isNaN(expenseId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }

  await prisma.transaction.update({
    where: { id: expenseId },
    data: { reimbursementTxId: null },
  })

  const updated = await prisma.transaction.findUnique({
    where: { id: expenseId },
    include: INCLUDE,
  })
  return NextResponse.json(updated)
}
