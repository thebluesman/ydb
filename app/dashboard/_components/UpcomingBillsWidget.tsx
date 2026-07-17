'use client'

import { Badge } from '@/app/_components/ui'
import { fromCents } from '@/lib/money'
import type { RecurringSeries } from '@/lib/recurring'

function fmtDate(iso: string) {
  const d = new Date(`${iso}T00:00:00`)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * "Upcoming this month" — recurring series (detected by lib/recurring.ts)
 * whose projected next occurrence falls in the current month, plus any that
 * are overdue from an earlier month (Phase 7 item 5). Sorted by next date
 * ascending so overdue/soonest bills lead.
 */
export function UpcomingBillsWidget({
  bills,
  currency,
}: {
  bills: RecurringSeries[]
  currency: string
}) {
  if (bills.length === 0) {
    return (
      <p className="text-sm py-4" style={{ color: 'var(--tx-faint)' }}>
        No recurring bills detected for this month.
      </p>
    )
  }

  return (
    <div className="space-y-2">
      {bills.map((b) => (
        <div
          key={`${b.description}-${b.nextDate}`}
          className="flex items-center justify-between gap-3 py-2 px-3 rounded-[6px]"
          style={{
            backgroundColor: b.isOverdue ? 'var(--bg-caution)' : 'var(--bg-card-alt)',
            border: '1px solid var(--border-warm)',
          }}
        >
          <div className="min-w-0">
            <p className="text-sm font-medium truncate" style={{ color: 'var(--tx-primary)' }}>
              {b.description}
            </p>
            <p className="text-xs" style={{ color: 'var(--tx-faint)' }}>
              {b.category} · due {fmtDate(b.nextDate)}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-none">
            {b.isOverdue && (
              <Badge variant="negative" shape="tag">
                Overdue
              </Badge>
            )}
            <span className="text-sm font-mono" style={{ color: 'var(--tx-primary)' }}>
              {currency} {fromCents(b.avgAmount).toFixed(2)}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}
