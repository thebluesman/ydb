'use client'

import { useState, useEffect } from 'react'
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts'
import type { AccountBalance, CashFlowRow } from '../page'

function fmtShort(v: number) {
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`
  return v.toFixed(0)
}

export function NetWorthWidget({
  accountBalances,
  cashFlowData,
  currency,
}: {
  accountBalances: AccountBalance[]
  cashFlowData: CashFlowRow[]
  currency: string
}) {
  const [isDark, setIsDark] = useState(false)

  useEffect(() => {
    const update = () => setIsDark(document.documentElement.classList.contains('dark'))
    update()
    const obs = new MutationObserver(update)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])

  const assets = accountBalances
    .filter((a) => a.accountType === 'current')
    .reduce((s, a) => s + Math.max(a.currentBalance, 0), 0)

  const liabilities = accountBalances
    .filter((a) => a.accountType === 'credit' || a.accountType === 'personal_loan' || a.accountType === 'auto_loan')
    .reduce((s, a) => {
      // Credit cards: negative balance = money owed
      if (a.accountType === 'credit') return s + Math.max(-a.currentBalance, 0)
      // Loans: positive balance = outstanding debt
      return s + Math.max(a.currentBalance, 0)
    }, 0)

  const netWorth = assets - liabilities

  const tick   = isDark ? 'rgba(242,241,237,0.45)' : 'rgba(38,37,30,0.45)'
  const grid   = isDark ? 'rgba(242,241,237,0.07)' : 'rgba(38,37,30,0.07)'

  const tooltipStyle: React.CSSProperties = {
    backgroundColor: 'var(--bg-card)',
    border: '1px solid var(--border-warm)',
    borderRadius: '6px',
    fontSize: '12px',
    color: 'var(--tx-primary)',
  }

  const fmt = (v: number) => `${currency} ${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  return (
    <div className="space-y-5">
      {/* Stat pills */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Assets',      value: fmt(assets),      tx: 'var(--tx-stat-income)' },
          { label: 'Liabilities', value: fmt(liabilities), tx: 'var(--tx-stat-expense)' },
          { label: 'Net Worth',   value: `${netWorth >= 0 ? '' : '−'}${fmt(Math.abs(netWorth))}`, tx: netWorth >= 0 ? 'var(--tx-stat-net-pos)' : 'var(--tx-stat-net-neg)' },
        ].map(({ label, value, tx }) => (
          <div key={label}>
            <p className="text-[11px] font-medium uppercase tracking-[0.048px] mb-0.5" style={{ color: 'var(--tx-secondary)' }}>{label}</p>
            <p className="text-lg font-semibold font-mono" style={{ color: tx, letterSpacing: '-0.5px' }}>{value}</p>
          </div>
        ))}
      </div>

      {/* Trend chart */}
      {cashFlowData.length > 1 && (
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={cashFlowData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={grid} />
            <XAxis dataKey="period" tick={{ fontSize: 11, fill: tick }} axisLine={false} tickLine={false} />
            <YAxis
              tick={{ fontSize: 11, fill: tick }}
              tickFormatter={(v) => `${currency} ${fmtShort(v)}`}
              axisLine={false} tickLine={false} width={72}
            />
            <Tooltip
              formatter={((value: unknown) => [fmt(Number(value)), 'Net Worth']) as never}
              contentStyle={tooltipStyle}
            />
            <Line
              type="monotone"
              dataKey="closingBalance"
              stroke={netWorth >= 0 ? '#6ee7b7' : '#f87171'}
              strokeWidth={2}
              dot={false}
              name="Net Worth"
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
