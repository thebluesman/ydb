import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await request.json()

  const updated = await prisma.transaction.update({
    where: { id: parseInt(id) },
    data: {
      ...(body.date !== undefined && { date: new Date(body.date) }),
      ...(body.amount !== undefined && { amount: body.amount }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.category !== undefined && { category: body.category }),
      ...(body.accountId !== undefined && { accountId: body.accountId }),
      ...(body.status !== undefined && { status: body.status }),
      notes: body.notes ?? null,
      ...(body.reimbursableFor !== undefined && { reimbursableFor: body.reimbursableFor }),
    },
    include: {
      account: { select: { name: true, currency: true } },
      splitLegs: { select: { id: true, amount: true, category: true, description: true } },
      reimbursementTx: { select: { id: true, amount: true, description: true } },
      reimbursedExpense: { select: { id: true, description: true } },
    },
  })

  return NextResponse.json(updated)
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  await prisma.transaction.delete({ where: { id: parseInt(id) } })
  return NextResponse.json({ ok: true })
}
