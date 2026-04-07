import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const { role, text, sql } = await request.json()
  const message = await prisma.chatMessage.create({
    data: { sessionId: parseInt(id), role, text, sql: sql ?? null },
  })
  await prisma.chatSession.update({
    where: { id: parseInt(id) },
    data: { updatedAt: new Date() },
  })
  return NextResponse.json(message)
}
