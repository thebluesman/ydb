import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  await prisma.budget.delete({ where: { id: parseInt(id) } })
  return NextResponse.json({ ok: true })
}
