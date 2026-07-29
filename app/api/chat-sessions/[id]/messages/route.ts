import { prisma } from '@/lib/prisma'
import { isNonAnswerReason } from '@/lib/chatNonAnswer'
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
  const { role, text, sql, nonAnswerReason } = await request.json()
  const message = await prisma.chatMessage.create({
    data: {
      sessionId,
      role,
      text,
      sql: sql ?? null,
      // ADR-0014: refusals are persisted like any other answer, so they survive
      // a reload and land in the history @qa builds fixtures from.
      nonAnswerReason: isNonAnswerReason(nonAnswerReason) ? nonAnswerReason : null,
    },
  })
  await prisma.chatSession.update({
    where: { id: sessionId },
    data: { updatedAt: new Date() },
  })
  return NextResponse.json(message)
}
