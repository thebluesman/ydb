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
