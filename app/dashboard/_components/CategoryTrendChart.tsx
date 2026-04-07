'use client'

import { useEffect, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer,
} from 'recharts'
import type { TrendCategory } from '../page'

function fmtShort(v: number) {
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`
  return Math.round(v).toString()
}

export function CategoryTrendChart({
  data,
  categories,
}: {
  data: Record<string, number | string>[]
  categories: TrendCategory[]
}) {
  const [isDark, setIsDark] = useState(false)

  useEffect(() => {
    const update = () => setIsDark(document.documentElement.classList.contains('dark'))
    update()
    const obs = new MutationObserver(update)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])

  const tick = isDark ? 'rgba(242,241,237,0.45)' : 'rgba(38,37,30,0.45)'
  const grid = isDark ? 'rgba(242,241,237,0.08)' : 'rgba(38,37,30,0.08)'

  if (categories.length === 0) {
    return <p className="text-sm" style={{ color: 'var(--tx-faint)' }}>No expense data for this period.</p>
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={grid} />
        <XAxis dataKey="month" tick={{ fontSize: 11, fill: tick }} />
        <YAxis tickFormatter={fmtShort} tick={{ fontSize: 11, fill: tick }} width={48} />
        <Tooltip
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          formatter={((value: any, name: any) => [fmtShort(Number(value)), String(name ?? '')]) as any}
          contentStyle={{
            backgroundColor: isDark ? '#222120' : '#f7f7f4',
            border: '1px solid rgba(38,37,30,0.12)',
            borderRadius: 8,
            fontSize: 12,
          }}
        />
        <Legend wrapperStyle={{ fontSize: 12, color: tick }} />
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
