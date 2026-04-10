import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const { targetId } = await request.json()
  const txId = parseInt(id)
  const tgtId = parseInt(targetId)

  await prisma.$transaction([
    prisma.transaction.update({ where: { id: txId }, data: { linkedTransferId: tgtId, transactionType: 'transfer' } }),
    prisma.transaction.update({ where: { id: tgtId }, data: { linkedTransferId: txId, transactionType: 'transfer' } }),
  ])

  const updated = await prisma.transaction.findUnique({
    where: { id: txId },
    include: { account: { select: { name: true, currency: true } } },
  })
  return NextResponse.json(updated)
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const txId = parseInt(id)
  const tx = await prisma.transaction.findUnique({ where: { id: txId } })

  if (tx?.linkedTransferId) {
    await prisma.$transaction([
      prisma.transaction.update({ where: { id: txId }, data: { linkedTransferId: null, transactionType: tx.amount >= 0 ? 'credit' : 'debit' } }),
      prisma.transaction.update({ where: { id: tx.linkedTransferId }, data: { linkedTransferId: null } }),
    ])
  }

  const updated = await prisma.transaction.findUnique({
    where: { id: txId },
    include: { account: { select: { name: true, currency: true } } },
  })
  return NextResponse.json(updated)
}
