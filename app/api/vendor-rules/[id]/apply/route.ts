import { prisma } from '@/lib/prisma'
import { colorForCategory } from '@/lib/category-colors'
import { matchesRule } from '@/lib/vendor-rule-match'
import { NextResponse } from 'next/server'

// POST /api/vendor-rules/[id]/apply — retro-apply a rule to already-imported
// transactions (IMPROVEMENT_PLAN Phase 7.7). Only touches *uncategorized* rows
// (category === '', the schema default — see LedgerRowCard's "Uncategorized"
// fallback) so it never clobbers a category a user picked deliberately.
// Reuses matchesRule from lib/vendor-rule-match.ts (Phase 3.2) rather than
// duplicating the match logic. `?dryRun=1` returns the would-be-affected
// count without writing.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: idStr } = await params
  const id = parseInt(idStr, 10)
  if (isNaN(id)) return NextResponse.json({ error: 'invalid id' }, { status: 400 })

  const { searchParams } = new URL(request.url)
  const dryRun = searchParams.get('dryRun') === '1'

  const rule = await prisma.vendorRule.findUnique({ where: { id } })
  if (!rule) return NextResponse.json({ error: 'Rule not found' }, { status: 404 })

  const candidates = await prisma.transaction.findMany({
    where: { status: { in: ['committed', 'reconciled'] }, category: '' },
    select: { id: true, description: true, originalDescription: true, amount: true },
  })

  const matchIds = candidates
    .filter((tx) => matchesRule(rule, tx.originalDescription ?? tx.description, tx.amount))
    .map((tx) => tx.id)

  if (dryRun) {
    return NextResponse.json({ count: matchIds.length })
  }

  if (matchIds.length === 0) {
    return NextResponse.json({ updated: 0 })
  }

  // Ledger lets arbitrary category strings in; auto-create rather than reject
  // so it shows up in Settings too (Phase 6.4 convention, same as
  // PATCH /api/transactions/bulk).
  await prisma.category.upsert({
    where: { name: rule.category },
    update: {},
    create: { name: rule.category, color: colorForCategory(rule.category) },
  })

  // Re-filter on category: '' at write time too, so a race with another
  // categorization between the read above and this write can't overwrite it.
  const result = await prisma.transaction.updateMany({
    where: { id: { in: matchIds }, category: '' },
    data: { category: rule.category },
  })

  return NextResponse.json({ updated: result.count })
}
