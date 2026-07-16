// Shared date-range presets for the dashboard and ledger filter bars — one
// definition so "This month"/"3M"/etc. compute identically on both screens.
// Ranges are computed in the caller's local timezone (Date getters, not UTC),
// matching how the DatePicker and the existing dashboard range already work.

export const DATE_PRESET_KEYS = ['thisMonth', 'lastMonth', '3m', 'ytd', 'all'] as const
export type DatePresetKey = (typeof DATE_PRESET_KEYS)[number]

export const DATE_PRESETS: { key: DatePresetKey; label: string }[] = [
  { key: 'thisMonth', label: 'This month' },
  { key: 'lastMonth', label: 'Last month' },
  { key: '3m', label: '3M' },
  { key: 'ytd', label: 'YTD' },
  { key: 'all', label: 'All' },
]

export type DateRange = { startDate: string | null; endDate: string | null }

function toYMD(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Compute the [startDate, endDate] (YYYY-MM-DD, inclusive) for a preset.
 *  `all` returns { startDate: null, endDate: null } — "no date filter". */
export function presetRange(preset: DatePresetKey, now: Date = new Date()): DateRange {
  const y = now.getFullYear()
  const m = now.getMonth()

  switch (preset) {
    case 'thisMonth':
      return { startDate: toYMD(new Date(y, m, 1)), endDate: toYMD(now) }
    case 'lastMonth':
      return { startDate: toYMD(new Date(y, m - 1, 1)), endDate: toYMD(new Date(y, m, 0)) }
    case '3m':
      return { startDate: toYMD(new Date(y, m - 2, 1)), endDate: toYMD(now) }
    case 'ytd':
      return { startDate: toYMD(new Date(y, 0, 1)), endDate: toYMD(now) }
    case 'all':
      return { startDate: null, endDate: null }
  }
}
