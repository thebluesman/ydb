'use client'

import { useEffect, useState } from 'react'
import { Modal, Button, useToast } from '@/app/_components/ui'
import { fromCents } from '@/lib/money'

type Suggestion = {
  expense: { id: number; description: string; amount: number; date: string; reimbursableFor: string | null; account: { id: number; name: string } }
  settlement: { id: number; description: string; amount: number; date: string; account: { id: number; name: string } }
  score: number
  matchReason: 'category' | 'description'
}

function formatDate(d: string) {
  return new Date(d).toISOString().split('T')[0]
}

/**
 * "Suggest matches" for outstanding reimbursements (FOLLOWUPS §1). Fetches
 * GET /api/reimbursements/suggest, then confirms each pair one at a time
 * through the existing POST /api/transactions/[id]/reimburse link endpoint —
 * no new linking logic here, just a bulk entry point onto it.
 */
export function ReimbursementSuggestModal({
  open,
  onClose,
  onLinked,
}: {
  open: boolean
  onClose: () => void
  onLinked: () => void
}) {
  const toast = useToast()
  const [loading, setLoading] = useState(false)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [busyId, setBusyId] = useState<number | null>(null)
  const [dismissed, setDismissed] = useState<Set<number>>(new Set())

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setDismissed(new Set())
    fetch('/api/reimbursements/suggest')
      .then((res) => res.json())
      .then((data) => setSuggestions(data.suggestions ?? []))
      .catch(() => toast.error('Could not load reimbursement suggestions'))
      .finally(() => setLoading(false))
    // toast is stable from context; omitting it avoids re-fetching on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const visible = suggestions.filter((s) => !dismissed.has(s.expense.id))

  const confirm = async (s: Suggestion) => {
    setBusyId(s.expense.id)
    try {
      const res = await fetch(`/api/transactions/${s.expense.id}/reimburse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId: s.settlement.id }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to link')
      setDismissed((prev) => new Set(prev).add(s.expense.id))
      toast.success(`Linked "${s.expense.description}" to its reimbursement`)
      onLinked()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to link')
    } finally {
      setBusyId(null)
    }
  }

  const dismiss = (s: Suggestion) => {
    setDismissed((prev) => new Set(prev).add(s.expense.id))
  }

  return (
    <Modal open={open} onClose={onClose} title="Suggested reimbursement matches" maxWidth={560}>
      {loading && <p className="text-sm" style={{ color: 'var(--tx-tertiary)' }}>Looking for matches…</p>}
      {!loading && visible.length === 0 && (
        <p className="text-sm" style={{ color: 'var(--tx-tertiary)' }}>
          No confident matches found. Link the rest manually from the ledger.
        </p>
      )}
      <div className="space-y-3 max-h-[60vh] overflow-y-auto">
        {visible.map((s) => (
          <div
            key={s.expense.id}
            className="p-3 rounded-[8px] text-sm space-y-2"
            style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-card)' }}
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <p style={{ color: 'var(--tx-primary)' }}>{s.expense.description}</p>
                <p className="text-xs" style={{ color: 'var(--tx-tertiary)' }}>
                  {formatDate(s.expense.date)} · {s.expense.account.name} · {fromCents(Math.abs(s.expense.amount)).toFixed(2)}
                </p>
              </div>
              <span className="text-xs" style={{ color: 'var(--tx-faint)' }}>→</span>
              <div className="text-right">
                <p style={{ color: 'var(--tx-primary)' }}>{s.settlement.description}</p>
                <p className="text-xs" style={{ color: 'var(--tx-tertiary)' }}>
                  {formatDate(s.settlement.date)} · {s.settlement.account.name} · {fromCents(s.settlement.amount).toFixed(2)}
                </p>
              </div>
            </div>
            <p className="text-xs" style={{ color: 'var(--tx-faint)' }}>
              Matched by {s.matchReason === 'category' ? 'category' : 'description similarity'} ({Math.round(s.score * 100)}%)
            </p>
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" onClick={() => dismiss(s)} disabled={busyId === s.expense.id}>
                Dismiss
              </Button>
              <Button variant="primary" onClick={() => confirm(s)} disabled={busyId === s.expense.id}>
                {busyId === s.expense.id ? 'Linking…' : 'Confirm'}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  )
}
