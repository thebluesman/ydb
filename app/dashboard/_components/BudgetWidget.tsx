'use client'

import { LineChart, Line, ReferenceLine, ResponsiveContainer, Tooltip } from 'recharts'
import { fromCents } from '@/lib/money'

type BudgetHistoryPoint = { month: string; actual: number }
type BudgetData = {
  category: string
  budget: number
  actual: number
  monthlyLimit: number
  history: BudgetHistoryPoint[]
}

function barColor(pct: number) {
  if (pct >= 1) return 'var(--tx-error)'
  if (pct >= 0.8) return '#f59e0b'
  return 'var(--tx-success)'
}

// Sparkline tooltip content — small enough that recharts' default doesn't
// need the full CategoryTrendChart tooltip styling, just currency-aware.
function HistoryTooltip({
  active,
  payload,
  label,
  currency,
  monthlyLimit,
}: {
  active?: boolean
  payload?: { value?: number }[]
  label?: string
  currency: string
  monthlyLimit: number
}) {
  if (!active || !payload?.length) return null
  const actual = payload[0]?.value ?? 0
  return (
    <div
      className="px-2 py-1 rounded text-[11px]"
      style={{
        backgroundColor: 'var(--bg-card)',
        border: '1px solid var(--border-warm)',
        color: 'var(--tx-primary)',
      }}
    >
      <div>{label}</div>
      <div style={{ color: actual > monthlyLimit ? 'var(--tx-negative)' : 'var(--tx-secondary)' }}>
        {currency} {fromCents(actual).toFixed(0)} of {fromCents(monthlyLimit).toFixed(0)}
      </div>
    </div>
  )
}

/** Small inline chart of the last ~6 months of spend for one category against
 *  its flat monthly limit line (Phase 7 item 6). */
function BudgetSparkline({
  history,
  monthlyLimit,
  currency,
  overBudget,
}: {
  history: BudgetHistoryPoint[]
  monthlyLimit: number
  currency: string
  overBudget: boolean
}) {
  if (history.length === 0) return null
  const lineColor = overBudget ? 'var(--tx-negative)' : 'var(--tx-tertiary)'
  return (
    <div style={{ width: 96, height: 32, flexShrink: 0 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={history} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
          {monthlyLimit > 0 && (
            <ReferenceLine y={monthlyLimit} stroke="var(--border-warm)" strokeDasharray="2 2" />
          )}
          <Line
            type="monotone"
            dataKey="actual"
            stroke={lineColor}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
          <Tooltip
            content={<HistoryTooltip currency={currency} monthlyLimit={monthlyLimit} />}
            cursor={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
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
        const overBudget = pct > 1
        return (
          <div key={b.category}>
            <div className="flex items-center justify-between gap-3 mb-1">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs font-medium truncate" style={{ color: 'var(--tx-primary)' }}>
                  {b.category}
                </span>
                {/* Distinct "over budget" callout — a badge, separate from the
                    inline "+X% over" figure in the amount label below (that
                    label states the magnitude; this flags the state at a
                    glance, same badge pattern as account-type chips
                    elsewhere on the dashboard). */}
                {overBudget && (
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded-full uppercase tracking-wider flex-shrink-0"
                    style={{ backgroundColor: 'var(--bg-negative)', color: 'var(--tx-negative)' }}
                  >
                    Over budget
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <BudgetSparkline
                  history={b.history}
                  monthlyLimit={b.monthlyLimit}
                  currency={currency}
                  overBudget={overBudget}
                />
                <span className="text-xs font-mono whitespace-nowrap" style={{ color }}>
                  {currency} {fromCents(b.actual).toFixed(0)} / {fromCents(b.budget).toFixed(0)}
                  {overBudget && (
                    <span className="ml-1 text-[10px]">+{((pct - 1) * 100).toFixed(0)}% over</span>
                  )}
                </span>
              </div>
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
