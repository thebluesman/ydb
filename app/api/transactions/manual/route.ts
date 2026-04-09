import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  const body: {
    date: string
    amount: number
    description: string
    category: string
    accountId: number
    notes?: string
    status?: string
  } = await request.json()

  if (!body.date || body.amount === undefined || !body.description || !body.accountId) {
    return NextResponse.json({ error: 'date, amount, description, and accountId are required' }, { status: 400 })
  }

  const transaction = await prisma.transaction.create({
    data: {
      date: new Date(body.date),
      amount: body.amount,
      description: body.description,
      category: body.category || 'Other',
      accountId: body.accountId,
      notes: body.notes ?? null,
      status: body.status ?? 'committed',
    },
    include: {
      account: { select: { name: true, currency: true } },
      splitLegs: { select: { id: true, amount: true, category: true, description: true } },
      reimbursementTx: { select: { id: true, amount: true, description: true } },
      reimbursedExpense: { select: { id: true, description: true } },
    },
  })

  return NextResponse.json(transaction)
}
