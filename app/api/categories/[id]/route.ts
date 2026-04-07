import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const categoryId = parseInt(id)
  if (isNaN(categoryId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }

  const { name, color } = await request.json()
  if (!name || typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'name required' }, { status: 400 })
  }

  const existing = await prisma.category.findUnique({ where: { id: categoryId } })
  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const oldName = existing.name
  const newName = name.trim()

  const updated = await prisma.$transaction(async (tx) => {
    const category = await tx.category.update({
      where: { id: categoryId },
      data: { name: newName, ...(color && { color }) },
    })
    if (oldName !== newName) {
      await tx.transaction.updateMany({
        where: { category: oldName },
        data: { category: newName },
      })
    }
    return category
  })

  return NextResponse.json(updated)
}
