'use client'

import type { TopTransaction } from '../page'
import { fromCents } from '@/lib/money'

function fmt(cents: number, currency: string) {
  return fromCents(Math.abs(cents)).toLocaleString('en-US', { style: 'currency', currency, maximumFractionDigits: 2 })
}

export function TopTransactionsPanel({
  transactions,
  currency,
}: {
  transactions: TopTransaction[]
  currency: string
}) {
  if (transactions.length === 0) {
    return <p className="text-sm" style={{ color: 'var(--tx-faint)' }}>No transactions for this period.</p>
  }

  return (
    <table className="w-full text-sm border-collapse">
      <thead>
        <tr style={{ backgroundColor: 'var(--bg-table-head)' }}>
          {['Date', 'Description', 'Category', 'Account', 'Amount'].map((col) => (
            <th
              key={col}
              className="px-4 py-2 text-left text-[11px] font-medium uppercase tracking-[0.048px]"
              style={{ color: 'var(--tx-secondary)', borderBottom: '1px solid var(--border-warm)' }}
            >
              {col}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {transactions.map((t, i) => (
          <tr
            key={t.id}
            style={{ backgroundColor: i % 2 === 0 ? 'transparent' : 'var(--bg-card-alt)' }}
          >
            <td className="px-4 py-2 font-mono text-xs whitespace-nowrap" style={{ color: 'var(--tx-secondary)' }}>
              {t.date}
            </td>
            <td className="px-4 py-2 text-xs max-w-[200px] truncate" style={{ color: 'var(--tx-primary)' }}>
              {t.description}
            </td>
            <td className="px-4 py-2 text-xs" style={{ color: 'var(--tx-secondary)' }}>
              {t.category}
            </td>
            <td className="px-4 py-2 text-xs" style={{ color: 'var(--tx-secondary)' }}>
              {t.accountName}
            </td>
            <td
              className="px-4 py-2 font-mono text-xs font-medium whitespace-nowrap"
              style={{ color: t.amount >= 0 ? 'var(--tx-success)' : 'var(--tx-error)' }}
            >
              {t.amount >= 0 ? '+' : '−'}{fmt(t.amount, currency)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
