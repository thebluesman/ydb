import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'
import { descriptionSimilarity } from '@/lib/textSimilarity'

const DAY_MS = 24 * 60 * 60 * 1000

type Candidate = { _id: string; accountId: number; amount: number; date: string; description: string }

export async function POST(request: Request) {
  const { candidates } = (await request.json()) as { candidates?: Candidate[] }

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return NextResponse.json({ duplicateIds: [], checked: 0, skipped: 0 })
  }

  // Only candidates with a usable date/account can be checked. (No arbitrary
  // 100-row cap any more — the whole set is checked with a single query.)
  const valid = candidates.filter((c) => c && c.accountId != null && c.date && !isNaN(Date.parse(c.date)))
  const skipped = candidates.length - valid.length

  if (valid.length === 0) {
    return NextResponse.json({ duplicateIds: [], checked: 0, skipped })
  }

  // One query: fetch every existing row for the involved accounts within the
  // overall ±1-day window spanning all candidates, then match in memory. This
  // replaces up to 100 sequential findMany round-trips.
  const times = valid.map((c) => Date.parse(c.date))
  const minDate = new Date(Math.min(...times) - DAY_MS)
  const maxDate = new Date(Math.max(...times) + DAY_MS)
  const accountIds = [...new Set(valid.map((c) => c.accountId))]

  const existing = await prisma.transaction.findMany({
    where: {
      accountId: { in: accountIds },
      date: { gte: minDate, lte: maxDate },
    },
    select: { accountId: true, amount: true, date: true, description: true },
  })

  // Bucket existing rows by accountId|amount for O(1) candidate lookup; amount
  // must match exactly (same rule as before), date within ±1 day, description
  // similarity ≥ 0.8.
  const buckets = new Map<string, { time: number; description: string }[]>()
  for (const m of existing) {
    const key = `${m.accountId}|${m.amount}`
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key)!.push({ time: new Date(m.date).getTime(), description: m.description })
  }

  const duplicateIds: string[] = []
  for (const c of valid) {
    const bucket = buckets.get(`${c.accountId}|${c.amount}`)
    if (!bucket) continue
    const t = Date.parse(c.date)
    const isDuplicate = bucket.some(
      (m) => Math.abs(m.time - t) <= DAY_MS && descriptionSimilarity(m.description, c.description) >= 0.8,
    )
    if (isDuplicate) duplicateIds.push(c._id)
  }

  return NextResponse.json({ duplicateIds, checked: valid.length, skipped })
}
