import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'

export async function GET() {
  const budgets = await prisma.budget.findMany({ orderBy: { category: 'asc' } })
  return NextResponse.json(budgets)
}

export async function POST(request: Request) {
  const { category, monthlyLimit } = await request.json()

  if (!category || typeof category !== 'string') {
    return NextResponse.json({ error: 'category is required' }, { status: 400 })
  }
  if (typeof monthlyLimit !== 'number' || monthlyLimit <= 0) {
    return NextResponse.json({ error: 'monthlyLimit must be a positive number' }, { status: 400 })
  }

  const budget = await prisma.budget.upsert({
    where: { category },
    update: { monthlyLimit },
    create: { category, monthlyLimit },
  })
  return NextResponse.json(budget)
}
