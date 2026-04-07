import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'

export async function GET() {
  const transactions = await prisma.transaction.findMany({
    orderBy: { date: 'desc' },
    include: {
      account: { select: { name: true, currency: true } },
      splitLegs: { select: { id: true, amount: true, category: true, description: true } },
    },
  })
  return NextResponse.json(transactions)
}

export async function POST(request: Request) {
  const body: Array<{
    date: string
    amount: number
    description: string
    category: string
    accountId: number
    notes?: string
    rawSource?: string
    status?: string
  }> = await request.json()

  if (!Array.isArray(body) || body.length === 0) {
    return NextResponse.json({ error: 'Expected non-empty array of transactions' }, { status: 400 })
  }

  const result = await prisma.transaction.createMany({
    data: body.map((t) => ({
      date: new Date(t.date),
      amount: t.amount,
      description: t.description,
      category: t.category,
      accountId: t.accountId,
      notes: t.notes ?? null,
      rawSource: t.rawSource ?? null,
      status: t.status ?? 'committed',
    })),
  })

  return NextResponse.json({ count: result.count })
}
