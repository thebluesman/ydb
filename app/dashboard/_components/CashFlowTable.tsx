'use client'

import type { CashFlowRow } from '../page'

function fmt(v: number, currency: string) {
  return v.toLocaleString('en-US', { style: 'currency', currency, maximumFractionDigits: 2 })
}

export function CashFlowTable({ data, currency }: { data: CashFlowRow[]; currency: string }) {
  if (data.length === 0) {
    return (
      <p className="text-sm" style={{ color: 'var(--tx-faint)' }}>No data for this period.</p>
    )
  }

  const cols = ['Period', 'Opening Balance', 'Income', 'Expenses', 'Net', 'Closing Balance']

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr style={{ backgroundColor: 'var(--bg-table-head)' }}>
            {cols.map((col) => (
              <th
                key={col}
                className="px-4 py-2 text-left text-[11px] font-medium uppercase tracking-[0.048px] whitespace-nowrap"
                style={{ color: 'var(--tx-secondary)', borderBottom: '1px solid var(--border-warm)' }}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => {
            const net = row.income - row.expenses
            return (
              <tr
                key={i}
                style={{ backgroundColor: i % 2 === 0 ? 'transparent' : 'var(--bg-card-alt)' }}
              >
                <td className="px-4 py-2 font-mono text-xs" style={{ color: 'var(--tx-primary)' }}>
                  {row.period}
                </td>
                <td className="px-4 py-2 font-mono text-xs" style={{ color: 'var(--tx-secondary)' }}>
                  {fmt(row.openingBalance, currency)}
                </td>
                <td className="px-4 py-2 font-mono text-xs" style={{ color: 'var(--tx-success)' }}>
                  +{fmt(row.income, currency)}
                </td>
                <td className="px-4 py-2 font-mono text-xs" style={{ color: 'var(--tx-error)' }}>
                  −{fmt(row.expenses, currency)}
                </td>
                <td
                  className="px-4 py-2 font-mono text-xs"
                  style={{ color: net >= 0 ? 'var(--tx-success)' : 'var(--tx-error)' }}
                >
                  {net >= 0 ? '+' : '−'}{fmt(Math.abs(net), currency)}
                </td>
                <td
                  className="px-4 py-2 font-mono text-xs font-medium"
                  style={{ color: row.closingBalance >= 0 ? 'var(--tx-success)' : 'var(--tx-error)' }}
                >
                  {fmt(row.closingBalance, currency)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
