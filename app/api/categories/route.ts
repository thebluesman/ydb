import { prisma } from '@/lib/prisma'
import { colorForCategory } from '@/lib/category-colors'
import { NextResponse } from 'next/server'

export async function GET() {
  const categories = await prisma.category.findMany({ orderBy: { name: 'asc' } })
  return NextResponse.json(categories)
}

export async function POST(request: Request) {
  const { name, color } = await request.json()

  if (!name || typeof name !== 'string') {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }

  const assignedColor = colorForCategory(name)
  const category = await prisma.category.upsert({
    where: { name },
    update: { color: assignedColor },
    create: { name, color: assignedColor },
  })

  return NextResponse.json(category)
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url)
  const id = parseInt(searchParams.get('id') ?? '', 10)
  const force = searchParams.get('force') === 'true'

  if (isNaN(id)) {
    return NextResponse.json({ error: 'id query param required' }, { status: 400 })
  }

  const category = await prisma.category.findUnique({ where: { id } })
  if (!category) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  if (!force) {
    const count = await prisma.transaction.count({ where: { category: category.name } })
    if (count > 0) {
      return NextResponse.json({ error: 'IN_USE', count }, { status: 409 })
    }
  }

  await prisma.category.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
