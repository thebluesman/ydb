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
  if (isNaN(txId) || isNaN(tgtId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }
  if (txId === tgtId) {
    return NextResponse.json({ error: 'cannot link a transaction to itself' }, { status: 400 })
  }

  const [tx, target] = await Promise.all([
    prisma.transaction.findUnique({
      where: { id: txId },
      include: { account: { select: { currency: true } } },
    }),
    prisma.transaction.findUnique({
      where: { id: tgtId },
      include: { account: { select: { currency: true } } },
    }),
  ])
  if (!tx) return NextResponse.json({ error: 'transaction not found' }, { status: 404 })
  if (!target) return NextResponse.json({ error: 'target not found' }, { status: 404 })

  if (tx.accountId === target.accountId) {
    return NextResponse.json(
      { error: 'linked transfers must span two different accounts' },
      { status: 400 },
    )
  }
  if (tx.account.currency !== target.account.currency) {
    return NextResponse.json(
      {
        error: `cross-currency transfers not supported (${tx.account.currency} → ${target.account.currency})`,
      },
      { status: 400 },
    )
  }
  // Either side already paired to a different row → refuse rather than
  // silently orphan the existing counterpart.
  if (tx.linkedTransferId !== null && tx.linkedTransferId !== tgtId) {
    return NextResponse.json({ error: 'source is already linked to another transaction' }, { status: 409 })
  }
  if (target.linkedTransferId !== null && target.linkedTransferId !== txId) {
    return NextResponse.json({ error: 'target is already linked to another transaction' }, { status: 409 })
  }

  await prisma.$transaction([
    prisma.transaction.update({
      where: { id: txId },
      data: {
        linkedTransferId: tgtId,
        transactionType: 'transfer',
        transferCounterpartAccountId: target.accountId,
      },
    }),
    prisma.transaction.update({
      where: { id: tgtId },
      data: {
        linkedTransferId: txId,
        transactionType: 'transfer',
        transferCounterpartAccountId: tx.accountId,
      },
    }),
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
  if (isNaN(txId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }
  const tx = await prisma.transaction.findUnique({ where: { id: txId } })

  if (tx?.linkedTransferId) {
    const counterpart = await prisma.transaction.findUnique({ where: { id: tx.linkedTransferId } })
    await prisma.$transaction([
      prisma.transaction.update({ where: { id: txId }, data: { linkedTransferId: null, transactionType: tx.amount >= 0 ? 'credit' : 'debit' } }),
      prisma.transaction.update({ where: { id: tx.linkedTransferId }, data: { linkedTransferId: null, transactionType: counterpart && counterpart.amount >= 0 ? 'credit' : 'debit' } }),
    ])
  }

  const updated = await prisma.transaction.findUnique({
    where: { id: txId },
    include: { account: { select: { name: true, currency: true } } },
  })
  return NextResponse.json(updated)
}
