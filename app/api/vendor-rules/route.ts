import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'

export async function GET() {
  const rules = await prisma.vendorRule.findMany({ orderBy: { vendor: 'asc' } })
  return NextResponse.json(rules)
}

export async function POST(request: Request) {
  const { pattern, vendor, category } = await request.json()

  if (!pattern || typeof pattern !== 'string') {
    return NextResponse.json({ error: 'pattern is required' }, { status: 400 })
  }
  if (!vendor || typeof vendor !== 'string') {
    return NextResponse.json({ error: 'vendor is required' }, { status: 400 })
  }
  if (!category || typeof category !== 'string') {
    return NextResponse.json({ error: 'category is required' }, { status: 400 })
  }

  const rule = await prisma.vendorRule.upsert({
    where: { pattern },
    update: { vendor, category },
    create: { pattern, vendor, category },
  })

  return NextResponse.json(rule)
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url)
  const id = parseInt(searchParams.get('id') ?? '', 10)

  if (isNaN(id)) {
    return NextResponse.json({ error: 'id query param required' }, { status: 400 })
  }

  await prisma.vendorRule.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
