import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const session = await prisma.chatSession.findUnique({
    where: { id: parseInt(id) },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  })
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(session)
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const { title } = await request.json()
  const session = await prisma.chatSession.update({
    where: { id: parseInt(id) },
    data: { title, updatedAt: new Date() },
  })
  return NextResponse.json(session)
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  await prisma.chatSession.delete({ where: { id: parseInt(id) } })
  return NextResponse.json({ ok: true })
}
