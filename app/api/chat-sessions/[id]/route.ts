import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const sessionId = parseInt(id)
  if (isNaN(sessionId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }
  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
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
  const sessionId = parseInt(id)
  if (isNaN(sessionId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }
  const { title } = await request.json()
  const session = await prisma.chatSession.update({
    where: { id: sessionId },
    data: { title, updatedAt: new Date() },
  })
  return NextResponse.json(session)
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const sessionId = parseInt(id)
  if (isNaN(sessionId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }
  await prisma.chatSession.delete({ where: { id: sessionId } })
  return NextResponse.json({ ok: true })
}
