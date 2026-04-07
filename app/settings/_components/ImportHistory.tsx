'use client'

import { History } from 'lucide-react'

type ImportRecord = {
  id: number
  filename: string
  transactionCount: number
  importedAt: string
  account: { name: string }
}

export function ImportHistory({ initialRecords }: { initialRecords: ImportRecord[] }) {
  if (initialRecords.length === 0) {
    return (
      <p className="text-sm" style={{ color: 'var(--tx-faint)' }}>
        No imports yet. Upload a statement to get started.
      </p>
    )
  }

  return (
    <div className="overflow-hidden rounded-[6px]" style={{ border: '1px solid var(--border-warm)' }}>
      <table className="w-full text-xs">
        <thead style={{ backgroundColor: 'var(--bg-table-head)' }}>
          <tr>
            {['File', 'Account', 'Transactions', 'Date'].map((h) => (
              <th key={h} className="px-3 py-2 text-left font-medium" style={{ color: 'var(--tx-secondary)' }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody style={{ backgroundColor: 'var(--bg-card)' }}>
          {initialRecords.map((r) => (
            <tr key={r.id} style={{ borderTop: '1px solid var(--border-warm)' }}>
              <td className="px-3 py-2 max-w-[200px] truncate font-mono" style={{ color: 'var(--tx-primary)' }}>
                {r.filename}
              </td>
              <td className="px-3 py-2" style={{ color: 'var(--tx-secondary)' }}>
                {r.account.name}
              </td>
              <td className="px-3 py-2 font-mono" style={{ color: 'var(--tx-secondary)' }}>
                {r.transactionCount}
              </td>
              <td className="px-3 py-2 whitespace-nowrap" style={{ color: 'var(--tx-faint)' }}>
                {new Date(r.importedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
