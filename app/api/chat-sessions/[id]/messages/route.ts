import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const sessionId = parseInt(id)
  if (isNaN(sessionId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }
  const { role, text, sql } = await request.json()
  const message = await prisma.chatMessage.create({
    data: { sessionId, role, text, sql: sql ?? null },
  })
  await prisma.chatSession.update({
    where: { id: sessionId },
    data: { updatedAt: new Date() },
  })
  return NextResponse.json(message)
}
