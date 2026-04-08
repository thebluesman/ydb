'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

type TxSummary = {
  id: number
  date: string | Date
  amount: number
  description: string
  reimbursedExpense: { id: number } | null
  account: { name: string; currency: string }
}

function formatDate(d: string | Date) {
  return new Date(d).toISOString().split('T')[0]
}

export function ReimburseLinkModal({
  expenseId,
  expenseDescription,
  expenseAmount,
  onLink,
  onClose,
}: {
  expenseId: number
  expenseDescription: string
  expenseAmount: number
  onLink: (settlementId: number, updatedExpense: object) => void
  onClose: () => void
}) {
  const [candidates, setCandidates] = useState<TxSummary[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [linking, setLinking] = useState<number | null>(null)

  useEffect(() => {
    fetch('/api/transactions')
      .then((r) => r.json())
      .then((all: TxSummary[]) => {
        const filtered = all.filter((t) => {
          if (t.id === expenseId) return false
          if (t.amount <= 0) return false                     // only credits
          if (t.reimbursedExpense !== null) return false      // already used
          return true
        })
        // Sort: closest in amount to the expense (absolute), most recent first as tiebreaker
        const absExpense = Math.abs(expenseAmount)
        filtered.sort((a, b) => {
          const aDiff = Math.abs(Math.abs(a.amount) - absExpense)
          const bDiff = Math.abs(Math.abs(b.amount) - absExpense)
          if (aDiff !== bDiff) return aDiff - bDiff
          return new Date(b.date).getTime() - new Date(a.date).getTime()
        })
        setCandidates(filtered)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [expenseId, expenseAmount])

  const handleLink = async (settlementId: number) => {
    setLinking(settlementId)
    try {
      const res = await fetch(`/api/transactions/${expenseId}/reimburse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId: settlementId }),
      })
      if (!res.ok) throw new Error(await res.text())
      const updated = await res.json()
      onLink(settlementId, updated)
    } catch { /* silent */ } finally {
      setLinking(null)
    }
  }

  const shown = candidates.filter(
    (t) => !search || t.description.toLowerCase().includes(search.toLowerCase())
  )

  const inputStyle: React.CSSProperties = {
    border: '1px solid var(--border-warm)',
    backgroundColor: 'var(--bg-input)',
    color: 'var(--tx-primary)',
  }

  const content = (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        backgroundColor: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        style={{
          backgroundColor: 'var(--bg-card)',
          border: '1px solid var(--border-warm)',
          borderRadius: '12px',
          padding: '24px',
          width: '540px',
          maxHeight: '70vh',
          overflowY: 'auto',
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        }}
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold" style={{ color: 'var(--tx-primary)' }}>
            Link Reimbursement
          </h2>
          <button onClick={onClose} style={{ color: 'var(--tx-tertiary)' }}>
            <X size={16} />
          </button>
        </div>

        <p className="text-xs mb-4" style={{ color: 'var(--tx-secondary)' }}>
          Select the credit transaction that settles &ldquo;{expenseDescription}&rdquo;.
          Sorted by closest amount match.
        </p>

        <input
          type="search"
          placeholder="Filter by description…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full px-3 py-2 text-sm rounded-[8px] outline-none mb-3"
          style={inputStyle}
        />

        {loading && (
          <p className="text-sm text-center py-6" style={{ color: 'var(--tx-faint)' }}>Loading…</p>
        )}

        {!loading && shown.length === 0 && (
          <p className="text-sm text-center py-6" style={{ color: 'var(--tx-faint)' }}>
            No available credit transactions found.
          </p>
        )}

        {!loading && shown.length > 0 && (
          <div className="space-y-1">
            {shown.map((t) => (
              <div
                key={t.id}
                className="flex items-center justify-between px-3 py-2 rounded-[6px]"
                style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-surface-200)' }}
              >
                <div className="flex-1 min-w-0 mr-3">
                  <p className="text-xs font-medium truncate" style={{ color: 'var(--tx-primary)' }}>
                    {t.description}
                  </p>
                  <p className="text-[11px]" style={{ color: 'var(--tx-secondary)' }}>
                    {formatDate(t.date)} · {t.account.name}
                  </p>
                </div>
                <span
                  className="text-xs font-mono mr-3 whitespace-nowrap"
                  style={{ color: 'var(--tx-success)' }}
                >
                  +{t.account.currency}{Math.abs(t.amount).toFixed(2)}
                </span>
                <button
                  onClick={() => handleLink(t.id)}
                  disabled={linking === t.id}
                  className="text-xs px-3 py-1 rounded-[6px] disabled:opacity-40 whitespace-nowrap"
                  style={{
                    backgroundColor: 'var(--bg-selected)',
                    color: 'var(--tx-selected)',
                    border: '1px solid var(--border-warm)',
                  }}
                >
                  {linking === t.id ? '…' : 'Link'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )

  return createPortal(content, document.body)
}
