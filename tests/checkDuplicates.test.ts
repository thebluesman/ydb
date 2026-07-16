import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Coverage for POST /api/transactions/check-duplicates (IMPROVEMENT_PLAN
// Phase 8 — none existed before). Mocks '@/lib/prisma' with an in-memory
// fake of the single findMany call the route makes (accountId + date-window
// scoped), following the same mock-prisma pattern as
// tests/transactionDeleteCascade.test.ts.

type ExistingRow = { accountId: number; amount: number; date: string; description: string }

let existingRows: ExistingRow[] = []
let lastFindManyArgs: unknown = null

vi.mock('@/lib/prisma', () => ({
  prisma: {
    transaction: {
      findMany: async (args: unknown) => {
        lastFindManyArgs = args
        return existingRows
      },
    },
  },
}))

import { POST } from '@/app/api/transactions/check-duplicates/route'

function makeRequest(candidates: unknown[]): Request {
  return new Request('http://localhost/api/transactions/check-duplicates', {
    method: 'POST',
    body: JSON.stringify({ candidates }),
  })
}

beforeEach(() => {
  existingRows = []
  lastFindManyArgs = null
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/transactions/check-duplicates', () => {
  it('returns empty result for an empty candidate list', async () => {
    const res = await POST(makeRequest([]))
    const body = await res.json()
    expect(body).toEqual({ duplicateIds: [], checked: 0, skipped: 0 })
  })

  it('flags a candidate matching an existing row on account+amount+date(±1d)+description similarity', async () => {
    existingRows = [{ accountId: 1, amount: -1000, date: '2026-01-05T00:00:00.000Z', description: 'TESCO STORES LONDON' }]
    const res = await POST(
      makeRequest([{ _id: 'c1', accountId: 1, amount: -1000, date: '2026-01-05T00:00:00.000Z', description: 'TESCO STORES LONDON' }]),
    )
    const body = await res.json()
    expect(body.duplicateIds).toEqual(['c1'])
    expect(body.checked).toBe(1)
    expect(body.skipped).toBe(0)
  })

  it('does NOT flag a candidate with a different amount at the same account/date', () => {
    return (async () => {
      existingRows = [{ accountId: 1, amount: -1000, date: '2026-01-05T00:00:00.000Z', description: 'TESCO STORES' }]
      const res = await POST(
        makeRequest([{ _id: 'c1', accountId: 1, amount: -2000, date: '2026-01-05T00:00:00.000Z', description: 'TESCO STORES' }]),
      )
      const body = await res.json()
      expect(body.duplicateIds).toEqual([])
    })()
  })

  it('does NOT flag a candidate more than 1 day away in date', async () => {
    existingRows = [{ accountId: 1, amount: -1000, date: '2026-01-01T00:00:00.000Z', description: 'TESCO STORES' }]
    const res = await POST(
      makeRequest([{ _id: 'c1', accountId: 1, amount: -1000, date: '2026-01-05T00:00:00.000Z', description: 'TESCO STORES' }]),
    )
    const body = await res.json()
    expect(body.duplicateIds).toEqual([])
  })

  it('does NOT flag a candidate whose description is too dissimilar despite matching amount/date', async () => {
    existingRows = [{ accountId: 1, amount: -1000, date: '2026-01-05T00:00:00.000Z', description: 'AMAZON MARKETPLACE' }]
    const res = await POST(
      makeRequest([{ _id: 'c1', accountId: 1, amount: -1000, date: '2026-01-05T00:00:00.000Z', description: 'NETFLIX SUBSCRIPTION' }]),
    )
    const body = await res.json()
    expect(body.duplicateIds).toEqual([])
  })

  it('does NOT flag a candidate against an existing row in a different account', async () => {
    existingRows = [{ accountId: 2, amount: -1000, date: '2026-01-05T00:00:00.000Z', description: 'TESCO STORES' }]
    const res = await POST(
      makeRequest([{ _id: 'c1', accountId: 1, amount: -1000, date: '2026-01-05T00:00:00.000Z', description: 'TESCO STORES' }]),
    )
    const body = await res.json()
    expect(body.duplicateIds).toEqual([])
  })

  it('skips candidates with a missing accountId or unparseable date, and still checks the rest', async () => {
    existingRows = [{ accountId: 1, amount: -1000, date: '2026-01-05T00:00:00.000Z', description: 'TESCO STORES' }]
    const res = await POST(
      makeRequest([
        { _id: 'bad1', accountId: null, amount: -1000, date: '2026-01-05T00:00:00.000Z', description: 'x' },
        { _id: 'bad2', accountId: 1, amount: -1000, date: 'not-a-date', description: 'x' },
        { _id: 'good', accountId: 1, amount: -1000, date: '2026-01-05T00:00:00.000Z', description: 'TESCO STORES' },
      ]),
    )
    const body = await res.json()
    expect(body.checked).toBe(1)
    expect(body.skipped).toBe(2)
    expect(body.duplicateIds).toEqual(['good'])
  })

  it('no arbitrary 100-candidate cap: checks every valid candidate in one pass (checked count matches input)', async () => {
    existingRows = []
    const candidates = Array.from({ length: 150 }, (_, i) => ({
      _id: `c${i}`,
      accountId: 1,
      amount: -100 - i,
      date: '2026-01-05T00:00:00.000Z',
      description: `row ${i}`,
    }))
    const res = await POST(makeRequest(candidates))
    const body = await res.json()
    expect(body.checked).toBe(150)
    expect(body.skipped).toBe(0)
  })

  it('scopes the lookup query to the involved accountIds and a date window spanning all candidates', async () => {
    existingRows = []
    await POST(
      makeRequest([
        { _id: 'a', accountId: 1, amount: -100, date: '2026-01-01T00:00:00.000Z', description: 'x' },
        { _id: 'b', accountId: 3, amount: -200, date: '2026-02-01T00:00:00.000Z', description: 'y' },
      ]),
    )
    const args = lastFindManyArgs as { where: { accountId: { in: number[] }; date: { gte: Date; lte: Date } } }
    expect(args.where.accountId.in.sort()).toEqual([1, 3])
    expect(args.where.date.gte.getTime()).toBeLessThan(new Date('2026-01-01T00:00:00.000Z').getTime())
    expect(args.where.date.lte.getTime()).toBeGreaterThan(new Date('2026-02-01T00:00:00.000Z').getTime())
  })
})
