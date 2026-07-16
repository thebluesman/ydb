'use client'

import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer,
} from 'recharts'
import type { TrendCategory } from '../page'
import { fromCents } from '@/lib/money'

function fmtShort(cents: number) {
  const v = fromCents(cents)
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`
  return Math.round(v).toString()
}

// Tick/grid/tooltip colors come from CSS custom properties (globals.css)
// rather than a JS isDark branch, so the chart re-themes for free when the
// .dark class toggles — no re-render needed for color alone.
const CHART_TICK_STYLE = { fontSize: 11, fill: 'var(--chart-tick)' }
const TOOLTIP_STYLE: React.CSSProperties = {
  backgroundColor: 'var(--bg-card)',
  border: '1px solid var(--border-warm)',
  borderRadius: 'var(--radius-md)',
  fontSize: 12,
  color: 'var(--tx-primary)',
}

export function CategoryTrendChart({
  data,
  categories,
}: {
  data: Record<string, number | string>[]
  categories: TrendCategory[]
}) {
  if (categories.length === 0) {
    return <p className="text-sm" style={{ color: 'var(--tx-faint)' }}>No expense data for this period.</p>
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
        <XAxis dataKey="month" tick={CHART_TICK_STYLE} />
        <YAxis tickFormatter={fmtShort} tick={CHART_TICK_STYLE} width={48} />
        <Tooltip
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          formatter={((value: any, name: any) => [fmtShort(Number(value)), String(name ?? '')]) as any}
          contentStyle={TOOLTIP_STYLE}
        />
        <Legend wrapperStyle={{ fontSize: 12, color: 'var(--chart-tick)' }} />
        {categories.map((cat) => (
          <Line
            key={cat.name}
            type="monotone"
            dataKey={cat.name}
            stroke={cat.color}
            strokeWidth={1.5}
            dot={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}
