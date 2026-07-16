import { prisma } from '@/lib/prisma'
import { countMatchingTransactions, ruleCountQuery } from '@/lib/vendor-rule-match'
import { NextResponse } from 'next/server'

const VALID_MATCH_TYPES = ['contains', 'starts-with', 'ends-with', 'exact', 'regex']
const VALID_DIRECTIONS = ['either', 'debit', 'credit']

// Plain GET returns rules only (what the upload/review flow needs). Add
// `?withCounts=1` to also compute how many transactions each rule matches —
// counts run in SQL for the non-regex match types, and fall back to JS only
// for the (rare) regex rules. The previous behaviour fetched 5,000 rows and
// ran every rule against all of them in JS on every settings render.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const withCounts = searchParams.get('withCounts') === '1'

  const rules = await prisma.vendorRule.findMany({ orderBy: [{ priority: 'asc' }, { vendor: 'asc' }] })
  if (!withCounts) return NextResponse.json(rules)

  // Only touch the transactions table in JS if a regex rule actually needs it.
  const hasRegex = rules.some((r) => r.matchType === 'regex')
  const regexTxns = hasRegex
    ? await prisma.transaction.findMany({
        where: { status: { in: ['committed', 'reconciled'] } },
        select: { description: true, originalDescription: true, amount: true },
      })
    : []

  const withCountsArr = await Promise.all(
    rules.map(async (r) => {
      const q = ruleCountQuery(r)
      let matchCount: number
      if (q) {
        const [row] = await prisma.$queryRawUnsafe<{ n: number | bigint }[]>(q.sql, ...q.params)
        matchCount = Number(row?.n ?? 0)
      } else {
        matchCount = countMatchingTransactions(r, regexTxns)
      }
      return { ...r, matchCount }
    }),
  )
  return NextResponse.json(withCountsArr)
}

const VALID_TRANSACTION_TYPES = ['credit', 'debit', 'transfer']

export async function POST(request: Request) {
  const body = await request.json()
  const { pattern, vendor, category } = body
  const matchType: string = body.matchType ?? 'contains'
  const direction: string = body.direction ?? 'either'
  const transactionType: string | null = body.transactionType ?? null
  const minAmount: number | null = body.minAmount ?? null
  const maxAmount: number | null = body.maxAmount ?? null
  const priority: number = body.priority ?? 0

  if (!pattern || typeof pattern !== 'string')
    return NextResponse.json({ error: 'pattern is required' }, { status: 400 })
  if (!vendor || typeof vendor !== 'string')
    return NextResponse.json({ error: 'vendor is required' }, { status: 400 })
  if (!category || typeof category !== 'string')
    return NextResponse.json({ error: 'category is required' }, { status: 400 })
  if (!VALID_MATCH_TYPES.includes(matchType))
    return NextResponse.json({ error: 'invalid matchType' }, { status: 400 })
  if (!VALID_DIRECTIONS.includes(direction))
    return NextResponse.json({ error: 'invalid direction' }, { status: 400 })
  if (transactionType !== null && !VALID_TRANSACTION_TYPES.includes(transactionType))
    return NextResponse.json({ error: 'invalid transactionType' }, { status: 400 })
  if (matchType === 'regex') {
    try { new RegExp(pattern) }
    catch { return NextResponse.json({ error: 'Invalid regex pattern' }, { status: 400 }) }
  }

  const rule = await prisma.vendorRule.create({
    data: { pattern, matchType, vendor, category, direction, transactionType, minAmount, maxAmount, priority },
  })
  return NextResponse.json({ ...rule, matchCount: 0 })
}

export async function PATCH(request: Request) {
  const body = await request.json()
  const id = parseInt(body.id)
  if (isNaN(id)) return NextResponse.json({ error: 'id required' }, { status: 400 })

  if (body.matchType && !VALID_MATCH_TYPES.includes(body.matchType))
    return NextResponse.json({ error: 'invalid matchType' }, { status: 400 })
  if (body.direction && !VALID_DIRECTIONS.includes(body.direction))
    return NextResponse.json({ error: 'invalid direction' }, { status: 400 })

  const newMatchType = body.matchType
  const newPattern = body.pattern
  if (newMatchType === 'regex' && newPattern) {
    try { new RegExp(newPattern) }
    catch { return NextResponse.json({ error: 'Invalid regex pattern' }, { status: 400 }) }
  }

  const data: Record<string, unknown> = {}
  if (body.pattern         !== undefined) data.pattern         = body.pattern
  if (body.matchType       !== undefined) data.matchType       = body.matchType
  if (body.vendor          !== undefined) data.vendor          = body.vendor
  if (body.category        !== undefined) data.category        = body.category
  if (body.direction       !== undefined) data.direction       = body.direction
  if (body.transactionType !== undefined) data.transactionType = body.transactionType || null
  if (body.minAmount       !== undefined) data.minAmount       = body.minAmount
  if (body.maxAmount       !== undefined) data.maxAmount       = body.maxAmount
  if (body.priority        !== undefined) data.priority        = body.priority

  const rule = await prisma.vendorRule.update({ where: { id }, data })
  return NextResponse.json(rule)
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url)
  const id = parseInt(searchParams.get('id') ?? '', 10)
  if (isNaN(id)) return NextResponse.json({ error: 'id query param required' }, { status: 400 })
  await prisma.vendorRule.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
