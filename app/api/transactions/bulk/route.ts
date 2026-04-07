import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'

export async function PATCH(request: Request) {
  const { ids, update } = await request.json()

  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: 'ids array required' }, { status: 400 })
  }
  if (!update || typeof update !== 'object') {
    return NextResponse.json({ error: 'update object required' }, { status: 400 })
  }

  const data: Record<string, unknown> = {}
  if (update.category !== undefined) data.category = update.category
  if (update.status !== undefined) data.status = update.status

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'no valid fields in update' }, { status: 400 })
  }

  const result = await prisma.transaction.updateMany({
    where: { id: { in: ids } },
    data,
  })

  return NextResponse.json({ updated: result.count })
}
