import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'

export async function GET() {
  const accounts = await prisma.account.findMany({ orderBy: { id: 'asc' } })
  return NextResponse.json(accounts)
}

export async function POST(request: Request) {
  const accounts: Array<{
    id?: number
    name: string
    accountType: string
    currency: string
    isActive?: boolean
    openingBalance?: number
    openingBalanceDate?: string | null
    creditLimit?: number | null
  }> = await request.json()

  if (!Array.isArray(accounts)) {
    return NextResponse.json({ error: 'Expected array of accounts' }, { status: 400 })
  }

  const results = await Promise.all(
    accounts.map((acc) => {
      const data = {
        name: acc.name,
        accountType: acc.accountType,
        currency: acc.currency,
        ...(acc.isActive !== undefined && { isActive: acc.isActive }),
        ...(acc.openingBalance !== undefined && { openingBalance: acc.openingBalance }),
        ...(acc.openingBalanceDate !== undefined && {
          openingBalanceDate: acc.openingBalanceDate ? new Date(acc.openingBalanceDate) : null,
        }),
        ...(acc.creditLimit !== undefined && { creditLimit: acc.creditLimit }),
      }
      if (acc.id) {
        return prisma.account.update({ where: { id: acc.id }, data })
      }
      return prisma.account.create({ data })
    })
  )

  return NextResponse.json(results)
}
