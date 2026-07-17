import { describe, expect, it } from 'vitest'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, parseLedgerQuery } from '@/lib/transactions-query'

// Dedicated row-cap coverage for the ledger query API (IMPROVEMENT_PLAN
// Phase 8). tests/sqlGuard.test.ts covers the chat SQL row cap
// (READONLY_ROW_CAP in lib/prisma.ts); this covers the separate cap on the
// ledger's own paginated `pageSize` param in lib/transactions-query.ts,
// which is what actually bounds how many rows GET /api/transactions
// serialises per page regardless of what a client requests.

describe('ledger pageSize cap', () => {
  it('defaults to DEFAULT_PAGE_SIZE when unset', () => {
    expect(parseLedgerQuery(new URLSearchParams()).pageSize).toBe(DEFAULT_PAGE_SIZE)
  })

  it('honours an explicit pageSize under the cap', () => {
    expect(parseLedgerQuery(new URLSearchParams('pageSize=10')).pageSize).toBe(10)
  })

  it('clamps a pageSize above MAX_PAGE_SIZE down to the cap', () => {
    expect(parseLedgerQuery(new URLSearchParams('pageSize=100000')).pageSize).toBe(MAX_PAGE_SIZE)
  })

  it('clamps a pageSize of 0 or negative up to the minimum of 1', () => {
    expect(parseLedgerQuery(new URLSearchParams('pageSize=0')).pageSize).toBe(1)
    expect(parseLedgerQuery(new URLSearchParams('pageSize=-50')).pageSize).toBe(1)
  })

  it('falls back to the default for a non-numeric pageSize', () => {
    expect(parseLedgerQuery(new URLSearchParams('pageSize=abc')).pageSize).toBe(DEFAULT_PAGE_SIZE)
  })

  it('MAX_PAGE_SIZE is a sane finite bound (regression guard against accidentally removing the cap)', () => {
    expect(MAX_PAGE_SIZE).toBeGreaterThan(0)
    expect(MAX_PAGE_SIZE).toBeLessThanOrEqual(1000)
  })
})
