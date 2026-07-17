import { beforeEach, describe, expect, it, vi } from 'vitest'

// Coverage for POST /api/vendor-rules/[id]/apply (IMPROVEMENT_PLAN Phase 7.7
// "Rules retro-apply"). In-memory fakes of the slice of Prisma the handler
// touches — vendorRule.findUnique, transaction.findMany/updateMany, and
// category.upsert — following the same mock-prisma pattern as
// tests/transactionDeleteCascade.test.ts. Real matching goes through the
// actual matchesRule() from lib/vendor-rule-match.ts (Phase 3.2), not a
// reimplementation, so this also guards against the route drifting from the
// shared matcher.

type Rule = {
  id: number
  pattern: string
  matchType: string
  vendor: string
  category: string
  direction: string
  transactionType: string | null
  minAmount: number | null
  maxAmount: number | null
  priority: number
}

type Tx = {
  id: number
  description: string
  originalDescription: string | null
  amount: number
  status: string
  category: string
}

let rules: Rule[] = []
let txns: Tx[] = []
let upsertedCategories: string[] = []

vi.mock('@/lib/prisma', () => ({
  prisma: {
    vendorRule: {
      findUnique: async ({ where: { id } }: { where: { id: number } }) =>
        rules.find((r) => r.id === id) ?? null,
    },
    transaction: {
      findMany: async ({ where }: { where: { status: { in: string[] }; category: string } }) =>
        txns
          .filter((t) => where.status.in.includes(t.status) && t.category === where.category)
          .map(({ id, description, originalDescription, amount }) => ({ id, description, originalDescription, amount })),
      updateMany: async ({ where, data }: { where: { id: { in: number[] }; category: string }; data: { category: string } }) => {
        let count = 0
        for (const t of txns) {
          if (where.id.in.includes(t.id) && t.category === where.category) {
            t.category = data.category
            count++
          }
        }
        return { count }
      },
    },
    category: {
      upsert: async ({ where: { name } }: { where: { name: string } }) => {
        upsertedCategories.push(name)
        return { id: 1, name, color: '#000' }
      },
    },
  },
}))

import { POST } from '@/app/api/vendor-rules/[id]/apply/route'

function makeRequest(id: number, dryRun = false): Request {
  return new Request(`http://localhost/api/vendor-rules/${id}/apply${dryRun ? '?dryRun=1' : ''}`, { method: 'POST' })
}

function callApply(id: number, dryRun = false) {
  return POST(makeRequest(id, dryRun), { params: Promise.resolve({ id: String(id) }) })
}

function rule(partial: Partial<Rule>): Rule {
  return {
    id: 1, pattern: '', matchType: 'contains', vendor: 'Vendor', category: 'Groceries',
    direction: 'either', transactionType: null, minAmount: null, maxAmount: null, priority: 0,
    ...partial,
  }
}

beforeEach(() => {
  rules = []
  txns = []
  upsertedCategories = []
  vi.clearAllMocks()
})

describe('POST /api/vendor-rules/[id]/apply', () => {
  it('404s for an unknown rule id', async () => {
    const res = await callApply(999)
    expect(res.status).toBe(404)
  })

  it('dry-run returns a count and does not write', async () => {
    rules = [rule({ id: 1, pattern: 'tesco', category: 'Groceries' })]
    txns = [
      { id: 1, description: 'TESCO STORES', originalDescription: null, amount: -1500, status: 'committed', category: '' },
      { id: 2, description: 'TESCO EXPRESS', originalDescription: null, amount: -500, status: 'committed', category: '' },
    ]
    const res = await callApply(1, true)
    const body = await res.json()
    expect(body.count).toBe(2)
    expect(txns[0].category).toBe('')
    expect(txns[1].category).toBe('')
    expect(upsertedCategories).toEqual([])
  })

  it('apply only touches uncategorized rows, skipping already-categorized matches', async () => {
    rules = [rule({ id: 1, pattern: 'tesco', category: 'Groceries' })]
    txns = [
      { id: 1, description: 'TESCO STORES', originalDescription: null, amount: -1500, status: 'committed', category: '' },
      { id: 2, description: 'TESCO EXPRESS', originalDescription: null, amount: -500, status: 'committed', category: 'Already Set' },
    ]
    const res = await callApply(1)
    const body = await res.json()
    expect(body.updated).toBe(1)
    expect(txns[0].category).toBe('Groceries')
    expect(txns[1].category).toBe('Already Set')
    expect(upsertedCategories).toEqual(['Groceries'])
  })

  it('respects match type / direction / amount gates', async () => {
    rules = [rule({ id: 1, pattern: 'tesco', category: 'Groceries', direction: 'debit', minAmount: 1000 })]
    txns = [
      // matches: debit, tesco, abs >= 1000
      { id: 1, description: 'TESCO STORES', originalDescription: null, amount: -1500, status: 'committed', category: '' },
      // wrong direction (credit)
      { id: 2, description: 'TESCO REFUND', originalDescription: null, amount: 1500, status: 'committed', category: '' },
      // below minAmount
      { id: 3, description: 'TESCO EXPRESS', originalDescription: null, amount: -500, status: 'committed', category: '' },
      // pattern doesn't match
      { id: 4, description: 'AMAZON', originalDescription: null, amount: -2000, status: 'committed', category: '' },
    ]
    const res = await callApply(1)
    const body = await res.json()
    expect(body.updated).toBe(1)
    expect(txns[0].category).toBe('Groceries')
    expect(txns[1].category).toBe('')
    expect(txns[2].category).toBe('')
    expect(txns[3].category).toBe('')
  })

  it('returns 0 updated and skips the category upsert when nothing matches', async () => {
    rules = [rule({ id: 1, pattern: 'nomatch', category: 'Groceries' })]
    txns = [{ id: 1, description: 'AMAZON', originalDescription: null, amount: -2000, status: 'committed', category: '' }]
    const res = await callApply(1)
    const body = await res.json()
    expect(body.updated).toBe(0)
    expect(upsertedCategories).toEqual([])
  })
})
