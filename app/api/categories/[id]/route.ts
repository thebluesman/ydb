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
      // Cascade rename to every table that stores the category by name.
      // Missing any of these leaves orphan references that silently drop
      // transactions out of budget/vendor-rule matching.
      await tx.transaction.updateMany({
        where: { category: oldName },
        data: { category: newName },
      })
      await tx.budget.updateMany({
        where: { category: oldName },
        data: { category: newName },
      })
      await tx.vendorRule.updateMany({
        where: { category: oldName },
        data: { category: newName },
      })
    }
    return category
  })

  return NextResponse.json(updated)
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const categoryId = parseInt(id)
  if (isNaN(categoryId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }

  const category = await prisma.category.findUnique({ where: { id: categoryId } })
  if (!category) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { searchParams } = new URL(request.url)
  const reassignTo = searchParams.get('reassignTo')

  const [txCount, budgetCount, ruleCount] = await Promise.all([
    prisma.transaction.count({ where: { category: category.name } }),
    prisma.budget.count({ where: { category: category.name } }),
    prisma.vendorRule.count({ where: { category: category.name } }),
  ])

  if (txCount + budgetCount + ruleCount > 0 && !reassignTo) {
    // Deleting with live references would leave orphans that break category
    // filters and budget matching. Require an explicit reassignment target.
    return NextResponse.json(
      {
        error: 'IN_USE',
        transactionCount: txCount,
        budgetCount,
        vendorRuleCount: ruleCount,
      },
      { status: 409 },
    )
  }

  await prisma.$transaction(async (tx) => {
    if (reassignTo && reassignTo !== category.name) {
      await tx.transaction.updateMany({
        where: { category: category.name },
        data: { category: reassignTo },
      })
      await tx.budget.updateMany({
        where: { category: category.name },
        data: { category: reassignTo },
      })
      await tx.vendorRule.updateMany({
        where: { category: category.name },
        data: { category: reassignTo },
      })
    }
    await tx.category.delete({ where: { id: categoryId } })
  })

  return NextResponse.json({ ok: true })
}
