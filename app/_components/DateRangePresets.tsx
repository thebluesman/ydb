'use client'

import { DATE_PRESETS, presetRange, type DateRange } from '@/lib/date-presets'

/** Quick date-range preset pills (This month · Last month · 3M · YTD · All),
 *  shared by the dashboard and ledger filter bars (Phase U5) so "3M" means
 *  the same thing on both screens. Selecting a preset calls `onSelect`
 *  immediately with the computed range — no separate "Apply" step, unlike
 *  the manual DatePicker pair next to it.
 *
 *  `currentRange` (the caller's actual applied start/end, '' for unset) is
 *  compared against each preset's computed range on every render, rather than
 *  tracking the last-clicked pill as its own state — otherwise the pill stays
 *  highlighted after "Clear filters" or a manual DatePicker edit moves the
 *  applied range away from it. */
export function DateRangePresets({
  onSelect,
  currentRange,
}: {
  onSelect: (range: DateRange) => void
  currentRange: { startDate: string; endDate: string }
}) {
  const active = DATE_PRESETS.find((p) => {
    const r = presetRange(p.key)
    return (r.startDate ?? '') === currentRange.startDate && (r.endDate ?? '') === currentRange.endDate
  })?.key ?? null

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {DATE_PRESETS.map((p) => (
        <button
          key={p.key}
          type="button"
          onClick={() => onSelect(presetRange(p.key))}
          className="btn px-2.5 py-1 text-[11px] rounded-full transition-colors duration-150"
          style={{
            border: '1px solid var(--border-warm)',
            backgroundColor: active === p.key ? 'var(--bg-selected)' : 'var(--bg-btn)',
            color: active === p.key ? 'var(--tx-selected)' : 'var(--tx-secondary)',
          }}
        >
          {p.label}
        </button>
      ))}
    </div>
  )
}
