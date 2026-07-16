import { describe, expect, it } from 'vitest'
import { presetRange } from '@/lib/date-presets'

// Fixed "now" so the assertions don't depend on the day the suite runs.
const NOW = new Date(2026, 6, 16) // 16 Jul 2026 (months are 0-indexed)

describe('presetRange', () => {
  it('thisMonth: 1st of the current month through today', () => {
    expect(presetRange('thisMonth', NOW)).toEqual({ startDate: '2026-07-01', endDate: '2026-07-16' })
  })

  it('lastMonth: full calendar range of the previous month', () => {
    expect(presetRange('lastMonth', NOW)).toEqual({ startDate: '2026-06-01', endDate: '2026-06-30' })
  })

  it('lastMonth handles a January "now" (previous month is December of the prior year)', () => {
    expect(presetRange('lastMonth', new Date(2026, 0, 15))).toEqual({
      startDate: '2025-12-01',
      endDate: '2025-12-31',
    })
  })

  it('3m: the 1st of two months ago through today', () => {
    expect(presetRange('3m', NOW)).toEqual({ startDate: '2026-05-01', endDate: '2026-07-16' })
  })

  it('ytd: Jan 1 of the current year through today', () => {
    expect(presetRange('ytd', NOW)).toEqual({ startDate: '2026-01-01', endDate: '2026-07-16' })
  })

  it('all: no bounds', () => {
    expect(presetRange('all', NOW)).toEqual({ startDate: null, endDate: null })
  })
})
