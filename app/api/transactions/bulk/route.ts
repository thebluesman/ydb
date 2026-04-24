import { prisma } from '@/lib/prisma'
import { validateTransactionWrite } from '@/lib/transactionValidation'
import { NextResponse } from 'next/server'

// Fields this endpoint may change. Everything else should go through the
// single-row PATCH so we stay on the same validation path.
type BulkUpdate = {
  transactionType?: string
  category?: string
  status?: string
}

export async function PATCH(request: Request) {
  const { ids, update }: { ids?: number[]; update?: BulkUpdate } = await request.json()

  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: 'ids array required' }, { status: 400 })
  }
  if (!update || typeof update !== 'object') {
    return NextResponse.json({ error: 'update object required' }, { status: 400 })
  }

  const data: Record<string, unknown> = {}
  if (update.transactionType !== undefined) data.transactionType = update.transactionType
  if (update.category !== undefined) data.category = update.category
  if (update.status !== undefined) data.status = update.status

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'no valid fields in update' }, { status: 400 })
  }

  // If the caller is changing transactionType, each affected row must still
  // obey the sign/type + transfer rules after the patch. Previously this path
  // happily flipped a +AED 50 row to "debit" and silently skewed the dashboard.
  if (update.transactionType !== undefined) {
    const rows = await prisma.transaction.findMany({
      where: { id: { in: ids } },
      select: { id: true, amount: true, accountId: true, transferCounterpartAccountId: true },
    })

    const errors: { id: number; error: string; field?: string }[] = []
    for (const r of rows) {
      const invalid = await validateTransactionWrite(
        {
          transactionType: update.transactionType,
          amount: r.amount,
          accountId: r.accountId,
          transferCounterpartAccountId: r.transferCounterpartAccountId,
        },
        { allowOneSidedTransfer: true },
      )
      if (invalid) errors.push({ id: r.id, ...invalid })
    }
    if (errors.length > 0) {
      return NextResponse.json(
        { error: 'one or more rows fail validation for the new transactionType', errors },
        { status: 400 },
      )
    }
  }

  const result = await prisma.transaction.updateMany({
    where: { id: { in: ids } },
    data,
  })

  return NextResponse.json({ updated: result.count })
}
