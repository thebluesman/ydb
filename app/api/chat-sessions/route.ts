import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'

export async function GET() {
  const sessions = await prisma.chatSession.findMany({
    orderBy: { updatedAt: 'desc' },
    take: 30,
    include: {
      messages: { take: 1, orderBy: { createdAt: 'asc' }, select: { text: true } },
    },
  })
  return NextResponse.json(sessions)
}

export async function POST() {
  const session = await prisma.chatSession.create({
    data: {},
    include: { messages: true },
  })
  return NextResponse.json(session)
}
