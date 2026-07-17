import { describe, expect, it } from 'vitest'
import { detectRecurring } from '@/lib/recurring'

type Tx = { id: number; date: Date; amount: number; description: string; category: string }

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
