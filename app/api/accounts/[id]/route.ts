import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const accountId = parseInt(id)
  if (isNaN(accountId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }

  const body = await request.json()
  const data: Record<string, unknown> = {}
  if (body.name !== undefined) data.name = body.name
  if (body.accountType !== undefined) data.accountType = body.accountType
  if (body.currency !== undefined) data.currency = body.currency
  if (body.isActive !== undefined) data.isActive = body.isActive
  if (body.openingBalance !== undefined) data.openingBalance = body.openingBalance
  if (body.openingBalanceDate !== undefined) {
    data.openingBalanceDate = body.openingBalanceDate ? new Date(body.openingBalanceDate) : null
  }
  if (body.creditLimit !== undefined) data.creditLimit = body.creditLimit

  const account = await prisma.account.update({ where: { id: accountId }, data })
  return NextResponse.json(account)
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const accountId = parseInt(id)
  if (isNaN(accountId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }

  const count = await prisma.transaction.count({ where: { accountId } })
  if (count > 0) {
    return NextResponse.json({ error: 'HAS_TRANSACTIONS', count }, { status: 409 })
  }

  await prisma.account.delete({ where: { id: accountId } })
  return NextResponse.json({ ok: true })
}
