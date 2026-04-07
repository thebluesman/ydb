import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'

export async function GET() {
  const txs = await prisma.transaction.findMany({
    where: { status: { in: ['committed', 'reconciled'] }, amount: { lt: 0 } },
    orderBy: { date: 'asc' },
    select: { id: true, date: true, amount: true, description: true, category: true },
    take: 2000,
  })

  // Group by normalized description prefix (first 20 chars, alphanumeric + space only)
  const groups = new Map<string, typeof txs>()
  for (const t of txs) {
    const key = t.description
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .slice(0, 20)
      .trim()
    if (!key) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(t)
  }

  const recurring = []
  for (const [, group] of groups) {
    if (group.length < 3) continue

    const sorted = [...group].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    )

    // Check cadence: average gap must be 25–40 days
    const gaps: number[] = []
    for (let i = 1; i < sorted.length; i++) {
      gaps.push(
        (new Date(sorted[i].date).getTime() - new Date(sorted[i - 1].date).getTime()) / 86_400_000
      )
    }
    const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length
    if (avgGap < 25 || avgGap > 40) continue

    // Check amount consistency: all within ±10% of median
    const amounts = sorted.map((t) => Math.abs(t.amount)).sort((a, b) => a - b)
    const median = amounts[Math.floor(amounts.length / 2)]
    if (median === 0) continue
    const consistent = amounts.every((a) => Math.abs(a - median) / median < 0.1)
    if (!consistent) continue

    recurring.push({
      description: sorted[sorted.length - 1].description,
      category: sorted[sorted.length - 1].category,
      occurrences: sorted.length,
      avgAmount: median,
      lastDate: sorted[sorted.length - 1].date,
      avgGap: Math.round(avgGap),
    })
  }

  return NextResponse.json(
    recurring.sort((a, b) => b.avgAmount - a.avgAmount)
  )
}
