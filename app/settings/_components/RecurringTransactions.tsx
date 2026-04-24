'use client'

import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { fromCents } from '@/lib/money'

type RecurringRow = {
  description: string
  category: string
  occurrences: number
  avgAmount: number
  lastDate: string
  avgGap: number
}

export function RecurringTransactions() {
  const [data, setData] = useState<RecurringRow[] | null>(null)
  const [loading, setLoading] = useState(true)

  const load = () => {
    setLoading(true)
    fetch('/api/recurring')
      .then((r) => r.json())
      .then((rows) => { setData(rows); setLoading(false) })
      .catch(() => { setData([]); setLoading(false) })
  }

  useEffect(() => { load() }, [])

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm py-4" style={{ color: 'var(--tx-faint)' }}>
        <RefreshCw size={14} className="animate-spin" />
        Scanning transactions…
      </div>
    )
  }

  if (!data || data.length === 0) {
    return (
      <p className="text-sm py-2" style={{ color: 'var(--tx-faint)' }}>
        No recurring transactions detected yet. You need at least 3 months of data.
      </p>
    )
  }

  return (
    <div className="rounded-[8px] overflow-hidden" style={{ border: '1px solid var(--border-warm)' }}>
      <table className="w-full text-xs">
        <thead style={{ backgroundColor: 'var(--bg-table-head)' }}>
          <tr>
            {['Description', 'Category', 'Est. Monthly', 'Occurrences', 'Last Seen'].map((h) => (
              <th key={h} className="px-3 py-2 text-left font-medium" style={{ color: 'var(--tx-secondary)' }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody style={{ backgroundColor: 'var(--bg-card)' }}>
          {data.map((r, i) => (
            <tr key={i} style={{ borderTop: '1px solid var(--border-warm)' }}>
              <td className="px-3 py-2 max-w-[200px] truncate" style={{ color: 'var(--tx-primary)' }}>
                {r.description}
              </td>
              <td className="px-3 py-2" style={{ color: 'var(--tx-secondary)' }}>
                {r.category}
              </td>
              <td className="px-3 py-2 font-mono" style={{ color: 'var(--tx-error)' }}>
                −{fromCents(r.avgAmount).toFixed(2)}
              </td>
              <td className="px-3 py-2 font-mono" style={{ color: 'var(--tx-secondary)' }}>
                {r.occurrences}×
              </td>
              <td className="px-3 py-2 whitespace-nowrap" style={{ color: 'var(--tx-faint)' }}>
                {new Date(r.lastDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
