import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const txId = parseInt(id)
  if (isNaN(txId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }
  const body = await request.json()

  const updated = await prisma.transaction.update({
    where: { id: txId },
    data: {
      ...(body.date !== undefined && { date: new Date(body.date) }),
      ...(body.amount !== undefined && { amount: body.amount }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.originalDescription !== undefined && { originalDescription: body.originalDescription }),
      ...(body.transactionType !== undefined && { transactionType: body.transactionType }),
      ...(body.category !== undefined && { category: body.category }),
      ...(body.accountId !== undefined && { accountId: body.accountId }),
      ...(body.status !== undefined && { status: body.status }),
      ...(body.notes !== undefined && { notes: body.notes ?? null }),
      ...(body.reimbursableFor !== undefined && { reimbursableFor: body.reimbursableFor }),
      ...(body.transferCounterpartAccountId !== undefined && { transferCounterpartAccountId: body.transferCounterpartAccountId }),
    },
    include: {
      account: { select: { name: true, currency: true } },
      splitLegs: { select: { id: true, amount: true, category: true, description: true } },
      reimbursementTx: { select: { id: true, amount: true, description: true } },
      reimbursedExpense: { select: { id: true, description: true } },
      transferCounterpartAccount: { select: { id: true, name: true } },
    },
  })

  return NextResponse.json(updated)
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const txId = parseInt(id)
  if (isNaN(txId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }
  await prisma.transaction.delete({ where: { id: txId } })
  return NextResponse.json({ ok: true })
}
