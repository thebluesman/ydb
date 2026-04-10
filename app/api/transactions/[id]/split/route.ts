import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'

type Leg = { amount: number; category: string; description?: string }

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const parentId = parseInt(id)
  const { legs }: { legs: Leg[] } = await request.json()

  if (!Array.isArray(legs) || legs.length < 2) {
    return NextResponse.json({ error: 'At least 2 split legs required' }, { status: 400 })
  }

  const parent = await prisma.transaction.findUnique({ where: { id: parentId } })
  if (!parent) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const sum = legs.reduce((s, l) => s + l.amount, 0)
  if (Math.abs(sum - parent.amount) > 0.01) {
    return NextResponse.json(
      { error: `Leg amounts (${sum.toFixed(2)}) must sum to parent amount (${parent.amount.toFixed(2)})` },
      { status: 400 }
    )
  }

  // Delete existing split legs for idempotency
  await prisma.transaction.deleteMany({ where: { parentTransactionId: parentId } })

  await prisma.transaction.createMany({
    data: legs.map((l) => ({
      date: parent.date,
      amount: l.amount,
      description: l.description ?? parent.description,
      transactionType: parent.transactionType,
      category: l.category,
      accountId: parent.accountId,
      status: parent.status,
      parentTransactionId: parentId,
    })),
  })

  const updated = await prisma.transaction.findUnique({
    where: { id: parentId },
    include: {
      account: { select: { name: true, currency: true } },
      splitLegs: { select: { id: true, amount: true, category: true, description: true } },
    },
  })
  return NextResponse.json(updated)
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  await prisma.transaction.deleteMany({ where: { parentTransactionId: parseInt(id) } })
  const updated = await prisma.transaction.findUnique({
    where: { id: parseInt(id) },
    include: {
      account: { select: { name: true, currency: true } },
      splitLegs: { select: { id: true, amount: true, category: true, description: true } },
    },
  })
  return NextResponse.json(updated)
}
