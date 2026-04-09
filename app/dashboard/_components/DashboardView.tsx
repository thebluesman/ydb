'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts'
import { CashFlowTable } from './CashFlowTable'
import { CategoryTrendChart } from './CategoryTrendChart'
import { TopTransactionsPanel } from './TopTransactionsPanel'
import { BudgetWidget } from './BudgetWidget'
import { NetWorthWidget } from './NetWorthWidget'
import type { AccountBalance, CashFlowRow, TopTransaction, TrendCategory, BudgetData } from '../page'

type CategoryBreakdown = { category: string; total: number; count: number }
type MonthlyData = { month: string; income: number; expenses: number; net: number }
type SummaryStats = { totalIncome: number; totalExpenses: number; net: number; txCount: number }

const SERIES = {
  expenses: '#f87171',
  income:   '#6ee7b7',
  net:      '#94a3b8',
  category: '#fb923c',
} as const

const cardStyle: React.CSSProperties = {
  backgroundColor: 'var(--bg-card)',
  border: '1px solid var(--border-warm)',
  borderRadius: '8px',
}

const tooltipStyle: React.CSSProperties = {
  backgroundColor: 'var(--bg-card)',
  border: '1px solid var(--border-warm)',
  borderRadius: '6px',
  fontSize: '12px',
  color: 'var(--tx-primary)',
}

export function DashboardView({
  categoryBreakdown,
  monthlyData,
  summaryStats,
  currency,
  availableCurrencies,
  selectedCurrency,
  accountBalances,
  cashFlowData,
  categoryTrendData,
  trendCategories,
  topTransactions,
  currentStartDate,
  currentEndDate,
  budgetData,
}: {
  categoryBreakdown: CategoryBreakdown[]
  monthlyData: MonthlyData[]
  summaryStats: SummaryStats
  currency: string
  availableCurrencies: string[]
  selectedCurrency: string
  accountBalances: AccountBalance[]
  cashFlowData: CashFlowRow[]
  categoryTrendData: Record<string, number | string>[]
  trendCategories: TrendCategory[]
  topTransactions: TopTransaction[]
  currentStartDate: string
  currentEndDate: string
  budgetData: BudgetData[]
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [isDark, setIsDark] = useState(false)
  const [startDate, setStartDate] = useState(currentStartDate)
  const [endDate, setEndDate] = useState(currentEndDate)
  const balScrollRef = useRef<HTMLDivElement>(null)
  const [balScroll, setBalScroll] = useState({ left: false, right: false })

  const updateBalScroll = () => {
    const el = balScrollRef.current
    if (!el) return
    setBalScroll({
      left: el.scrollLeft > 0,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
    })
  }

  useEffect(() => {
    updateBalScroll()
  }, [accountBalances])

  useEffect(() => {
    const el = document.documentElement
    const check = () => setIsDark(el.classList.contains('dark'))
    check()
    const obs = new MutationObserver(check)
    obs.observe(el, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])

  const tick   = isDark ? 'rgba(242,241,237,0.45)' : 'rgba(38,37,30,0.45)'
  const grid   = isDark ? 'rgba(242,241,237,0.07)' : 'rgba(38,37,30,0.07)'
  const cursor = isDark ? 'rgba(242,241,237,0.06)' : 'rgba(38,37,30,0.04)'

  const fmt = (v: number) =>
    `${currency} ${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const fmtShort = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v)))

  const pushParams = (overrides: Record<string, string>) => {
    const p = new URLSearchParams(searchParams?.toString() ?? '')
    for (const [k, v] of Object.entries(overrides)) p.set(k, v)
    router.push(`/dashboard?${p.toString()}`)
  }

  const handleCurrencyClick = (c: string) => pushParams({ currency: c })

  const handleApplyDates = () => {
    if (startDate && endDate) pushParams({ startDate, endDate })
  }

  const pillBase: React.CSSProperties = {
    border: '1px solid var(--border-warm)',
    borderRadius: '20px',
    padding: '4px 12px',
    fontSize: '12px',
    cursor: 'pointer',
    transition: 'background 0.15s, color 0.15s',
  }

  return (
    <div className="space-y-5">
      {/* ── Filter bar ─────────────────────────────────────────────────────── */}
      <div
        className="p-4 rounded-[8px] flex flex-wrap items-center gap-4"
        style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-warm)' }}
      >
        {/* Currency pills */}
        {availableCurrencies.length > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium uppercase tracking-[0.048px]" style={{ color: 'var(--tx-secondary)' }}>
              Currency
            </span>
            {availableCurrencies.map((c) => (
              <button
                key={c}
                onClick={() => handleCurrencyClick(c)}
                style={{
                  ...pillBase,
                  backgroundColor: c === selectedCurrency ? 'var(--bg-selected)' : 'var(--bg-btn)',
                  color: c === selectedCurrency ? 'var(--tx-selected)' : 'var(--tx-primary)',
                }}
              >
                {c}
              </button>
            ))}
          </div>
        )}

        {/* Date range */}
        <div className="flex items-center gap-2 ml-auto">
          <span className="text-[11px] font-medium uppercase tracking-[0.048px]" style={{ color: 'var(--tx-secondary)' }}>
            Period
          </span>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="px-2 py-1 text-xs rounded-[6px] outline-none"
            style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }}
          />
          <span className="text-xs" style={{ color: 'var(--tx-faint)' }}>to</span>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="px-2 py-1 text-xs rounded-[6px] outline-none"
            style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }}
          />
          <button
            onClick={handleApplyDates}
            className="px-3 py-1 text-xs rounded-[6px] transition-colors duration-150"
            style={{ backgroundColor: 'var(--bg-btn)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}
          >
            Apply
          </button>
        </div>
      </div>

      {/* ── Account balances ───────────────────────────────────────────────── */}
      {accountBalances.length > 0 && (
        <div style={{ position: 'relative', overflowY: 'clip' }}>
          <div
            ref={balScrollRef}
            className="bal-scroll flex gap-4"
            style={{ overflowX: 'auto', scrollbarWidth: 'none', paddingTop: 24, paddingBottom: 36 }}
            onScroll={updateBalScroll}
          >
            <style>{`.bal-scroll::-webkit-scrollbar{display:none}`}</style>
          {accountBalances.map((acc) => (
            <div
              key={acc.id}
              className="card-hover flex-none p-6 rounded-[8px]"
              style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-warm)', minWidth: 220 }}
            >
              <div className="flex items-center gap-2 mb-2">
                <p className="text-xs font-medium truncate" style={{ color: 'var(--tx-primary)' }}>
                  {acc.name}
                </p>
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded-full uppercase tracking-wider"
                  style={{
                    backgroundColor:
                      acc.accountType === 'credit' ? 'var(--bg-badge-review)' :
                      acc.accountType === 'personal_loan' || acc.accountType === 'auto_loan' ? 'var(--bg-badge-reconciled)' :
                      'var(--bg-badge-committed)',
                    color:
                      acc.accountType === 'credit' ? 'var(--tx-badge-review)' :
                      acc.accountType === 'personal_loan' || acc.accountType === 'auto_loan' ? 'var(--tx-badge-reconciled)' :
                      'var(--tx-badge-committed)',
                  }}
                >
                  {acc.accountType === 'personal_loan' ? 'Personal Loan'
                    : acc.accountType === 'auto_loan' ? 'Auto Loan'
                    : acc.accountType === 'credit' ? 'Credit'
                    : acc.accountType === 'savings' ? 'Savings'
                    : acc.accountType === 'cash' ? 'Cash'
                    : acc.accountType}
                </span>
              </div>
              {(acc.accountType === 'personal_loan' || acc.accountType === 'auto_loan') && (
                <p className="text-[10px] mb-0.5" style={{ color: 'var(--tx-faint)' }}>outstanding</p>
              )}
              <p
                className="text-lg font-mono font-medium"
                style={{
                  color:
                    acc.accountType === 'personal_loan' || acc.accountType === 'auto_loan'
                      ? 'var(--tx-stat-expense)'
                      : acc.currentBalance >= 0 ? 'var(--tx-stat-income)' : 'var(--tx-stat-expense)',
                  letterSpacing: '-0.5px',
                }}
              >
                {acc.currentBalance >= 0 ? '' : '−'}
                {Math.abs(acc.currentBalance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
              {acc.accountType === 'credit' && acc.creditLimit != null && (() => {
                const used = Math.abs(acc.currentBalance)
                const utilPct = Math.min(100, Math.round((used / acc.creditLimit) * 100))
                const available = acc.creditLimit - used
                const barColor = utilPct >= 90 ? 'var(--tx-error)' : utilPct >= 30 ? 'var(--tx-badge-review)' : 'var(--tx-success)'
                return (
                  <div className="mt-3 space-y-1">
                    <div className="flex justify-between text-[10px]" style={{ color: 'var(--tx-faint)' }}>
                      <span>{utilPct}% used</span>
                      <span>{Math.abs(available).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} available</span>
                    </div>
                    <div className="rounded-full overflow-hidden" style={{ height: 4, backgroundColor: 'var(--border-warm-md)' }}>
                      <div style={{ width: `${utilPct}%`, height: '100%', backgroundColor: barColor, borderRadius: 9999, transition: 'width 0.3s' }} />
                    </div>
                    <p className="text-[10px]" style={{ color: 'var(--tx-faint)' }}>
                      of {acc.creditLimit.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} limit
                    </p>
                  </div>
                )
              })()}
              {acc.openingBalanceDate && (
                <p className="text-[10px] mt-1" style={{ color: 'var(--tx-faint)' }}>
                  since {acc.openingBalanceDate}
                </p>
              )}
            </div>
          ))}
          </div>
          {/* Gradient fades */}
          {(() => {
            const bg = isDark ? '#1a1917' : '#f2f1ed'
            const fadeStyle = (dir: 'left' | 'right'): React.CSSProperties => ({
              position: 'absolute',
              top: 0,
              [dir]: 0,
              width: 80,
              height: '100%',
              pointerEvents: 'none',
              transition: 'opacity 0.2s',
              background: `linear-gradient(to ${dir === 'left' ? 'right' : 'left'}, ${bg}, transparent)`,
            })
            return (
              <>
                {balScroll.left  && <div style={fadeStyle('left')}  />}
                {balScroll.right && <div style={fadeStyle('right')} />}
              </>
            )
          })()}
        </div>
      )}

      {/* ── Net Worth ──────────────────────────────────────────────────────── */}
      {accountBalances.length > 0 && (
        <div className="p-6 rounded-[8px]" style={cardStyle}>
          <p className="text-[11px] font-medium uppercase tracking-[0.048px] mb-1" style={{ color: 'var(--tx-secondary)' }}>
            Net Worth
          </p>
          <p className="text-xs mb-5" style={{ color: 'var(--tx-faint)' }}>Assets minus liabilities · {selectedCurrency}</p>
          <NetWorthWidget accountBalances={accountBalances} cashFlowData={cashFlowData} currency={selectedCurrency} />
        </div>
      )}

      {/* ── Budget widget ──────────────────────────────────────────────────── */}
      {budgetData.length > 0 && (
        <div className="p-6 rounded-[8px]" style={cardStyle}>
          <p className="text-[11px] font-medium uppercase tracking-[0.048px] mb-1" style={{ color: 'var(--tx-secondary)' }}>
            Monthly Budgets
          </p>
          <p className="text-xs mb-5" style={{ color: 'var(--tx-faint)' }}>Current month · spend vs limit</p>
          <BudgetWidget budgetData={budgetData} currency={currency} />
        </div>
      )}

      {/* ── Summary stat cards ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-4">
        {([
          { label: 'Total Income',   value: `+${fmt(summaryStats.totalIncome)}`,  sub: `${summaryStats.txCount} transactions`, bg: 'var(--bg-stat-income)',  tx: 'var(--tx-stat-income)' },
          { label: 'Total Expenses', value: `−${fmt(summaryStats.totalExpenses)}`, sub: 'selected period',                      bg: 'var(--bg-stat-expense)', tx: 'var(--tx-stat-expense)' },
          {
            label: 'Net',
            value: `${summaryStats.net >= 0 ? '+' : '−'}${fmt(Math.abs(summaryStats.net))}`,
            sub: 'selected period',
            bg: 'var(--bg-stat-net)',
            tx: summaryStats.net >= 0 ? 'var(--tx-stat-net-pos)' : 'var(--tx-stat-net-neg)',
          },
        ] as const).map(({ label, value, sub, bg, tx }) => (
          <div key={label} className="card-hover p-5 rounded-[8px]" style={{ backgroundColor: bg, border: '1px solid var(--border-warm)' }}>
            <p className="text-[11px] font-medium uppercase tracking-[0.048px] mb-2" style={{ color: 'var(--tx-secondary)' }}>{label}</p>
            <p className="text-xl font-semibold font-mono" style={{ color: tx, letterSpacing: '-0.5px' }}>{value}</p>
            <p className="text-xs mt-1" style={{ color: 'var(--tx-faint)' }}>{sub}</p>
          </div>
        ))}
      </div>

      {/* ── Spending by Category ───────────────────────────────────────────── */}
      <div className="p-6 rounded-[8px]" style={cardStyle}>
        <p className="text-[11px] font-medium uppercase tracking-[0.048px] mb-1" style={{ color: 'var(--tx-secondary)' }}>
          Spending by Category
        </p>
        <p className="text-xs mb-5" style={{ color: 'var(--tx-faint)' }}>Selected period · expenses only</p>
        {categoryBreakdown.length === 0 ? (
          <p className="text-sm py-8 text-center" style={{ color: 'var(--tx-faint)' }}>No expense data yet.</p>
        ) : (
          <ResponsiveContainer width="100%" height={Math.max(categoryBreakdown.length * 38, 200)}>
            <BarChart data={categoryBreakdown} layout="vertical" margin={{ top: 0, right: 24, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke={grid} />
              <XAxis
                type="number"
                tick={{ fontSize: 11, fill: tick }}
                tickFormatter={(v) => `${currency} ${fmtShort(v)}`}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                type="category"
                dataKey="category"
                width={120}
                tick={{ fontSize: 11, fill: tick }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
              formatter={(value: any) => [fmt(Number(value)), 'Spent']}
                contentStyle={tooltipStyle}
                cursor={{ fill: cursor }}
              />
              <Bar dataKey="total" fill={SERIES.category} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ── Monthly Overview ───────────────────────────────────────────────── */}
      <div className="p-6 rounded-[8px]" style={cardStyle}>
        <p className="text-[11px] font-medium uppercase tracking-[0.048px] mb-1" style={{ color: 'var(--tx-secondary)' }}>
          Monthly Overview
        </p>
        <p className="text-xs mb-5" style={{ color: 'var(--tx-faint)' }}>Selected period · income vs. expenses</p>
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={monthlyData} margin={{ top: 8, right: 24, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={grid} />
            <XAxis dataKey="month" tick={{ fontSize: 11, fill: tick }} axisLine={false} tickLine={false} />
            <YAxis
              tick={{ fontSize: 11, fill: tick }}
              tickFormatter={(v) => `${currency} ${fmtShort(v)}`}
              axisLine={false}
              tickLine={false}
              width={80}
            />
            <Tooltip
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              formatter={((value: any, name: any) => [fmt(Number(value)), String(name ?? '').charAt(0).toUpperCase() + String(name ?? '').slice(1)]) as any}
              contentStyle={tooltipStyle}
              cursor={{ fill: cursor }}
            />
            <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '16px', color: tick }} />
            <Bar dataKey="income"   fill={SERIES.income}   name="Income"   radius={[3, 3, 0, 0]} />
            <Bar dataKey="expenses" fill={SERIES.expenses} name="Expenses" radius={[3, 3, 0, 0]} />
            <Line type="monotone" dataKey="net" stroke={SERIES.net} strokeWidth={1.5} dot={false} name="Net" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* ── Category Trends ────────────────────────────────────────────────── */}
      <div className="p-6 rounded-[8px]" style={cardStyle}>
        <p className="text-[11px] font-medium uppercase tracking-[0.048px] mb-1" style={{ color: 'var(--tx-secondary)' }}>
          Category Trends
        </p>
        <p className="text-xs mb-5" style={{ color: 'var(--tx-faint)' }}>Monthly spend per category</p>
        <CategoryTrendChart data={categoryTrendData} categories={trendCategories} />
      </div>

      {/* ── Cash Flow Statement ────────────────────────────────────────────── */}
      <div className="p-6 rounded-[8px]" style={cardStyle}>
        <p className="text-[11px] font-medium uppercase tracking-[0.048px] mb-1" style={{ color: 'var(--tx-secondary)' }}>
          Cash Flow Statement
        </p>
        <p className="text-xs mb-5" style={{ color: 'var(--tx-faint)' }}>
          Opening → income → expenses → closing balance per period
        </p>
        <CashFlowTable data={cashFlowData} currency={currency} />
      </div>

      {/* ── Top 10 Transactions ────────────────────────────────────────────── */}
      <div className="p-6 rounded-[8px]" style={cardStyle}>
        <p className="text-[11px] font-medium uppercase tracking-[0.048px] mb-1" style={{ color: 'var(--tx-secondary)' }}>
          Largest Transactions
        </p>
        <p className="text-xs mb-5" style={{ color: 'var(--tx-faint)' }}>Top 10 by absolute value · selected period</p>
        <TopTransactionsPanel transactions={topTransactions} currency={currency} />
      </div>
    </div>
  )
}
