import { prisma } from '@/lib/prisma'
import { matchesRule } from '@/lib/vendor-rule-match'
import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const id = parseInt(searchParams.get('id') ?? '', 10)
  if (isNaN(id)) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const rule = await prisma.vendorRule.findUnique({ where: { id } })
  if (!rule) return NextResponse.json({ error: 'Rule not found' }, { status: 404 })

  const transactions = await prisma.transaction.findMany({
    where: { status: { in: ['committed', 'reconciled'] } },
    select: { id: true, date: true, description: true, amount: true, category: true },
    orderBy: { date: 'desc' },
  })

  const matches = transactions.filter((tx) => matchesRule(rule, tx.description, tx.amount))

  return NextResponse.json({
    total: matches.length,
    transactions: matches.slice(0, 500).map((tx) => ({
      ...tx,
      date: tx.date.toISOString().split('T')[0],
    })),
  })
}
