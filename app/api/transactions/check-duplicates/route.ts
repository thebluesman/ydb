import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'

function similarity(a: string, b: string): number {
  const s1 = a.toLowerCase()
  const s2 = b.toLowerCase()
  if (s1 === s2) return 1
  if (s1.includes(s2) || s2.includes(s1)) return 0.9
  // Character overlap ratio
  const longer = s1.length > s2.length ? s1 : s2
  const shorter = s1.length > s2.length ? s2 : s1
  let matches = 0
  for (const ch of shorter) {
    if (longer.includes(ch)) matches++
  }
  return matches / longer.length
}

export async function POST(request: Request) {
  const { candidates } = await request.json()

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return NextResponse.json({ duplicateIds: [] })
  }

  const duplicateIds: string[] = []

  for (const c of candidates.slice(0, 100)) {
    const date = new Date(c.date)
    const dayBefore = new Date(date); dayBefore.setDate(dayBefore.getDate() - 1)
    const dayAfter  = new Date(date); dayAfter.setDate(dayAfter.getDate() + 1)

    const matches = await prisma.transaction.findMany({
      where: {
        accountId: c.accountId,
        amount: c.amount,
        date: { gte: dayBefore, lte: dayAfter },
      },
    })

    const isDuplicate = matches.some((m) => similarity(m.description, c.description) >= 0.8)
    if (isDuplicate) duplicateIds.push(c._id)
  }

  return NextResponse.json({ duplicateIds })
}
