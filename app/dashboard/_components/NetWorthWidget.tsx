'use client'

import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts'
import type { AccountBalance, NetWorthPoint } from '../page'
import { isAsset, isLiability } from '@/lib/accounts'
import { fromCents } from '@/lib/money'

// Input arrives as integer cents.
function fmtShort(cents: number) {
  const v = fromCents(cents)
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`
  return v.toFixed(0)
}

// Tick/grid/tooltip colors come from CSS custom properties (globals.css)
// rather than a JS isDark branch, so the chart re-themes for free when the
// .dark class toggles.
const CHART_TICK_STYLE = { fontSize: 11, fill: 'var(--chart-tick)' }
const TOOLTIP_STYLE: React.CSSProperties = {
  backgroundColor: 'var(--bg-card)',
  border: '1px solid var(--border-warm)',
  borderRadius: 'var(--radius-sm)',
  fontSize: '12px',
  color: 'var(--tx-primary)',
}

export function NetWorthWidget({
  accountBalances,
  netWorthHistory,
  currency,
}: {
  accountBalances: AccountBalance[]
  netWorthHistory: NetWorthPoint[]
  currency: string
}) {
  // Under the canonical convention (lib/accounts.ts) currentBalance is cash
  // for assets and debt owed for liabilities. Treat both sign-aligned.
  const assets = accountBalances
    .filter((a) => isAsset(a.accountType))
    .reduce((s, a) => s + Math.max(a.currentBalance, 0), 0)

  const liabilities = accountBalances
    .filter((a) => isLiability(a.accountType))
    .reduce((s, a) => s + Math.max(a.currentBalance, 0), 0)

  const netWorth = assets - liabilities

  const fmt = (cents: number) => `${currency} ${fromCents(Math.abs(cents)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

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

      {/* Net-worth trend — monthly series across all accounts (assets minus
          liabilities), computed server-side in app/dashboard/page.tsx from
          one grouped SQL query per lib/transactions-query.ts (Phase 7 item 4). */}
      {netWorthHistory.length > 1 && (
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={netWorthHistory} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
            <XAxis dataKey="period" tick={CHART_TICK_STYLE} axisLine={false} tickLine={false} />
            <YAxis
              tick={CHART_TICK_STYLE}
              tickFormatter={(v) => `${currency} ${fmtShort(v)}`}
              axisLine={false} tickLine={false} width={72}
            />
            <Tooltip
              formatter={((value: unknown) => [fmt(Number(value)), 'Net Worth']) as never}
              contentStyle={TOOLTIP_STYLE}
            />
            <Line
              type="monotone"
              dataKey="netWorth"
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
