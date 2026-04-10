import { prisma } from '@/lib/prisma'
import { findMatchingRule } from '@/lib/vendor-rule-match'
import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  // Prefer originalDescription (raw text) for matching, fall back to description
  const description = searchParams.get('originalDescription') ?? searchParams.get('description') ?? ''
  const amount = parseFloat(searchParams.get('amount') ?? '0') || 0

  const rules = await prisma.vendorRule.findMany({
    orderBy: [{ priority: 'asc' }, { id: 'asc' }],
  })

  const matched = findMatchingRule(rules, description, amount)
  return NextResponse.json({ matched: matched !== null, matchedRule: matched ?? null })
}
