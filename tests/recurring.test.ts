import { describe, expect, it, vi } from 'vitest'

type Tx = { id: number; date: Date; amount: number; description: string; category: string }
type FullTx = Tx & { status: string; transactionType: string; accountId: number }

// getRecurringSeries's DB query fetches newest-first (review fix on PR #18: an
// `asc` order fed the detector a years-stale slice). It no longer passes a global
// `take` — capping is done per description group in JS (takeRecentPerGroup) — so
// this fake just honors `orderBy` and returns every matching row.
let fixtureTxs: FullTx[] = []
vi.mock('@/lib/prisma', () => ({
  prisma: {
    transaction: {
      findMany: async ({ orderBy }: { orderBy: { date: 'asc' | 'desc' } }) => {
        return [...fixtureTxs].sort((a, b) =>
          orderBy.date === 'desc' ? b.date.getTime() - a.date.getTime() : a.date.getTime() - b.date.getTime(),
        )
      },
    },
  },
}))

const { detectRecurring, getRecurringSeries, takeRecentPerGroup } = await import('@/lib/recurring')

let nextId = 1
function tx(dateIso: string, amount: number, description = 'Netflix Subscription', category = 'Entertainment'): Tx {
  return { id: nextId++, date: new Date(`${dateIso}T00:00:00Z`), amount, description, category }
}

describe('detectRecurring', () => {
  it('projects the next date as lastDate + avgGap days', () => {
    // Three ~30-day-apart debits.
    const txs = [tx('2026-04-15', -1500), tx('2026-05-15', -1500), tx('2026-06-15', -1500)]
    const asOf = new Date('2026-06-20T00:00:00Z')
    const [series] = detectRecurring(txs, asOf)

    // Apr15->May15 is 30 days, May15->Jun15 is 31 days (May has 31 days);
    // avg 30.5 rounds to 31.
    expect(series).toBeDefined()
    expect(series.avgGap).toBe(31)
    expect(series.lastDate).toBe('2026-06-15')
    expect(series.nextDate).toBe('2026-07-16')
  })

  it('flags a series overdue when the projected next date is before today', () => {
    const txs = [tx('2026-03-01', -1000), tx('2026-04-01', -1000), tx('2026-05-01', -1000)]
    // Last occurrence 2026-05-01 + ~31 day avg gap -> next expected ~2026-06-01,
    // well before an asOf of mid-July.
    const asOf = new Date('2026-07-17T00:00:00Z')
    const [series] = detectRecurring(txs, asOf)

    expect(series.isOverdue).toBe(true)
    expect(series.isDueThisMonth).toBe(false)
  })

  it('flags a series due this month when the projected next date falls in the current month and is not yet in the past', () => {
    const txs = [tx('2026-04-20', -2000), tx('2026-05-20', -2000), tx('2026-06-20', -2000)]
    // Next expected 2026-07-21; asOf is earlier in July so it's upcoming, not overdue.
    const asOf = new Date('2026-07-05T00:00:00Z')
    const [series] = detectRecurring(txs, asOf)

    expect(series.nextDate).toBe('2026-07-21')
    expect(series.isDueThisMonth).toBe(true)
    expect(series.isOverdue).toBe(false)
  })

  it('does not flag a series as overdue once asOf is on the projected next date itself', () => {
    const txs = [tx('2026-04-15', -1500), tx('2026-05-15', -1500), tx('2026-06-15', -1500)]
    const asOf = new Date('2026-07-16T00:00:00Z') // exactly the projected nextDate
    const [series] = detectRecurring(txs, asOf)

    expect(series.nextDate).toBe('2026-07-16')
    expect(series.isOverdue).toBe(false)
    expect(series.isDueThisMonth).toBe(true)
  })

  it('ignores series with fewer than 3 occurrences', () => {
    const txs = [tx('2026-04-15', -1500), tx('2026-05-15', -1500)]
    expect(detectRecurring(txs)).toHaveLength(0)
  })

  it('ignores series whose average gap is outside the 25-40 day cadence window', () => {
    const txs = [tx('2026-01-01', -1500), tx('2026-02-15', -1500), tx('2026-04-01', -1500)] // ~45 day gaps
    expect(detectRecurring(txs)).toHaveLength(0)
  })

  it('ignores series with inconsistent amounts (>10% deviation from median)', () => {
    const txs = [tx('2026-04-15', -1500), tx('2026-05-15', -3000), tx('2026-06-15', -1500)]
    expect(detectRecurring(txs)).toHaveLength(0)
  })

  it('keeps multiple independent series separate', () => {
    const netflix = [tx('2026-04-15', -1500, 'Netflix Subscription'), tx('2026-05-15', -1500, 'Netflix Subscription'), tx('2026-06-15', -1500, 'Netflix Subscription')]
    const gym = [tx('2026-04-01', -5000, 'Gym Membership Fee', 'Health'), tx('2026-05-01', -5000, 'Gym Membership Fee', 'Health'), tx('2026-06-01', -5000, 'Gym Membership Fee', 'Health')]
    const series = detectRecurring([...netflix, ...gym], new Date('2026-06-20T00:00:00Z'))
    expect(series).toHaveLength(2)
    expect(series.map((s) => s.description).sort()).toEqual(['Gym Membership Fee', 'Netflix Subscription'])
  })
})

describe('takeRecentPerGroup', () => {
  it('keeps only the most recent N rows per normalized description group', () => {
    // Newest-first input across two groups; cap of 2 per group.
    const rows = [
      { id: 1, description: 'Netflix Subscription', date: '2026-06' },
      { id: 2, description: 'Store Purchase', date: '2026-05' },
      { id: 3, description: 'Netflix Subscription', date: '2026-04' },
      { id: 4, description: 'Netflix Subscription', date: '2026-03' }, // over cap for its group
      { id: 5, description: 'Store Purchase', date: '2026-02' },
      { id: 6, description: 'Store Purchase', date: '2026-01' }, // over cap for its group
    ]
    const kept = takeRecentPerGroup(rows, 2)
    expect(kept.map((r) => r.id)).toEqual([1, 2, 3, 5])
  })

  it('buckets by the same normalized key detectRecurring uses (punctuation/case insensitive)', () => {
    const rows = [
      { id: 1, description: 'NETFLIX Subscription!!!' },
      { id: 2, description: 'netflix subscription #999' },
    ]
    // Both normalize to 'netflix subscription' → one group; cap of 1 keeps the first.
    expect(takeRecentPerGroup(rows, 1).map((r) => r.id)).toEqual([1])
  })
})

describe('getRecurringSeries', () => {
  it('drops a years-old, no-longer-active series in favor of a currently-active one', async () => {
    // A dead 2020 series. Per-group windowing no longer truncates it out of the
    // detection window (each group keeps its own recent history), so it IS
    // detected — but the liveness cut drops it: its last occurrence is many
    // cadence periods before asOf.
    const stale: FullTx[] = [
      { id: 1, date: new Date('2020-01-01T00:00:00Z'), amount: -1000, description: 'Old Gym', category: 'Health', status: 'committed', transactionType: 'debit', accountId: 1 },
      { id: 2, date: new Date('2020-02-01T00:00:00Z'), amount: -1000, description: 'Old Gym', category: 'Health', status: 'committed', transactionType: 'debit', accountId: 1 },
      { id: 3, date: new Date('2020-03-01T00:00:00Z'), amount: -1000, description: 'Old Gym', category: 'Health', status: 'committed', transactionType: 'debit', accountId: 1 },
    ]
    // A currently-active series, ~30 days apart.
    const active: FullTx[] = [
      { id: 10, date: new Date('2026-04-15T00:00:00Z'), amount: -1500, description: 'Netflix Subscription', category: 'Entertainment', status: 'committed', transactionType: 'debit', accountId: 1 },
      { id: 11, date: new Date('2026-05-15T00:00:00Z'), amount: -1500, description: 'Netflix Subscription', category: 'Entertainment', status: 'committed', transactionType: 'debit', accountId: 1 },
      { id: 12, date: new Date('2026-06-15T00:00:00Z'), amount: -1500, description: 'Netflix Subscription', category: 'Entertainment', status: 'committed', transactionType: 'debit', accountId: 1 },
    ]
    fixtureTxs = [...stale, ...active]

    const asOf = new Date('2026-06-20T00:00:00Z')
    const series = await getRecurringSeries(asOf)

    expect(series).toHaveLength(1)
    expect(series[0].description).toBe('Netflix Subscription')
  })

  it('detects a low-volume monthly series buried under high unrelated transaction volume', async () => {
    // A genuine monthly subscription: 4 occurrences over ~4 months.
    const netflix: FullTx[] = [
      { id: 1, date: new Date('2026-03-15T00:00:00Z'), amount: -1500, description: 'Netflix Subscription', category: 'Entertainment', status: 'committed', transactionType: 'debit', accountId: 1 },
      { id: 2, date: new Date('2026-04-15T00:00:00Z'), amount: -1500, description: 'Netflix Subscription', category: 'Entertainment', status: 'committed', transactionType: 'debit', accountId: 1 },
      { id: 3, date: new Date('2026-05-15T00:00:00Z'), amount: -1500, description: 'Netflix Subscription', category: 'Entertainment', status: 'committed', transactionType: 'debit', accountId: 1 },
      { id: 4, date: new Date('2026-06-15T00:00:00Z'), amount: -1500, description: 'Netflix Subscription', category: 'Entertainment', status: 'committed', transactionType: 'debit', accountId: 1 },
    ]
    // A large volume of unrelated one-off debits, ALL newer than the Netflix
    // series and numerous enough to exceed the old global cap (2000). Each has a
    // distinct description, so they form many single-row groups (never recurring)
    // — but under a global newest-first cap they'd fill the whole window and push
    // every Netflix occurrence out of it, so the series would go undetected.
    const noise: FullTx[] = []
    for (let i = 0; i < 2100; i++) {
      noise.push({
        id: 1000 + i,
        date: new Date('2026-07-01T00:00:00Z'),
        amount: -(500 + i),
        description: `Store Purchase ${i}`,
        category: 'Shopping',
        status: 'committed',
        transactionType: 'debit',
        accountId: 1,
      })
    }
    fixtureTxs = [...netflix, ...noise]

    const asOf = new Date('2026-07-10T00:00:00Z')
    const series = await getRecurringSeries(asOf)

    expect(series.map((s) => s.description)).toContain('Netflix Subscription')
  })
})
