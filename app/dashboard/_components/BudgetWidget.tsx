'use client'

import { fromCents } from '@/lib/money'

type BudgetData = { category: string; budget: number; actual: number }

function barColor(pct: number) {
  if (pct >= 1) return 'var(--tx-error)'
  if (pct >= 0.8) return '#f59e0b'
  return 'var(--tx-success)'
}

export function BudgetWidget({
  budgetData,
  currency,
}: {
  budgetData: BudgetData[]
  currency: string
}) {
  return (
    <div className="space-y-3">
      {budgetData.map((b) => {
        const pct = b.budget > 0 ? b.actual / b.budget : 0
        const pctDisplay = Math.min(pct, 1)
        const color = barColor(pct)
        return (
          <div key={b.category}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium" style={{ color: 'var(--tx-primary)' }}>
                {b.category}
              </span>
              <span className="text-xs font-mono" style={{ color }}>
                {currency} {fromCents(b.actual).toFixed(0)} / {fromCents(b.budget).toFixed(0)}
                {pct > 1 && (
                  <span className="ml-1 text-[10px]">+{((pct - 1) * 100).toFixed(0)}% over</span>
                )}
              </span>
            </div>
            <div
              className="h-1.5 rounded-full overflow-hidden"
              style={{ backgroundColor: 'var(--border-warm)' }}
            >
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${pctDisplay * 100}%`, backgroundColor: color }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
