import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'

export async function GET() {
  const records = await prisma.importRecord.findMany({
    orderBy: { importedAt: 'desc' },
    take: 50,
    include: { account: { select: { name: true } } },
  })
  return NextResponse.json(records)
}

export async function POST(request: Request) {
  const { filename, accountId, transactionCount } = await request.json()
  const record = await prisma.importRecord.create({
    data: { filename, accountId, transactionCount },
    include: { account: { select: { name: true } } },
  })
  return NextResponse.json(record)
}
