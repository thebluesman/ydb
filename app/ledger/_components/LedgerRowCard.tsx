'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, Scissors, Link2 } from 'lucide-react'
import { DatePicker } from '@/app/_components/DatePicker'
import { Select, Badge, Button, Modal, useToast } from '@/app/_components/ui'
import type { BadgeVariant } from '@/app/_components/ui'
import { fromCents, toCents } from '@/lib/money'
import { deleteWithUndo } from './deleteWithUndo'

type SplitLeg = { id: number; amount: number; category: string; description: string }

type Transaction = {
  id: number
  date: string | Date
  amount: number
  description: string
  originalDescription: string | null
  transactionType: string
  category: string
  accountId: number
  status: string
  notes: string | null
  linkedTransferId: number | null
  parentTransactionId: number | null
  splitLegs?: SplitLeg[]
  account: { name: string; currency: string }
  reimbursableFor: string | null
  reimbursementTxId: number | null
  reimbursementTx: { id: number; amount: number; description: string } | null
  reimbursedExpense: { id: number; description: string } | null
  transferCounterpartAccountId: number | null
  transferCounterpartAccount: { id: number; name: string } | null
}

type Category = { id: number; name: string; color: string }

const STATUS_BADGE: Record<string, { variant: BadgeVariant; label: string }> = {
  committed:  { variant: 'positive', label: 'Committed' },
  reconciled: { variant: 'info',     label: 'Reconciled' },
  review:     { variant: 'caution',  label: 'Review' },
}

const TYPE_OPTIONS = [
  { value: 'debit',    label: 'Debit'    },
  { value: 'credit',   label: 'Credit'   },
  { value: 'transfer', label: 'Transfer' },
]

function formatDate(d: string | Date) {
  return new Date(d).toISOString().split('T')[0]
}

/**
 * Mobile sibling of LedgerRow — same handler contract, stacked-card layout
 * instead of a table row. Full split/transfer-link editing stays a
 * desktop-only power feature; the card can view but not restructure those.
 */
export function LedgerRowCard({
  transaction,
  categories,
  onUpdate,
  onDelete,
  onRestore,
  selected,
  onToggleSelect,
}: {
  transaction: Transaction
  categories: Category[]
  onUpdate: (updated: Transaction) => void
  onDelete: (id: number) => void
  onRestore?: () => void
  selected?: boolean
  onToggleSelect?: (id: number) => void
}) {
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [error, setError] = useState('')

  const [draft, setDraft] = useState({
    date: formatDate(transaction.date),
    description: transaction.description,
    absAmount: fromCents(Math.abs(transaction.amount)),
    transactionType: transaction.transactionType,
    category: transaction.category,
    status: transaction.status,
    notes: transaction.notes ?? '',
  })

  const statusCfg = STATUS_BADGE[transaction.status] ?? STATUS_BADGE.review
  const isExpense = transaction.amount < 0

  const handleSave = async () => {
    setSaving(true)
    setError('')
    try {
      const signedAmount = isExpense || draft.transactionType === 'debit'
        ? -Math.abs(toCents(draft.absAmount))
        : Math.abs(toCents(draft.absAmount))
      const res = await fetch(`/api/transactions/${transaction.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: draft.date,
          description: draft.description,
          transactionType: draft.transactionType,
          category: draft.category,
          amount: signedAmount,
          status: draft.status,
          notes: draft.notes,
        }),
      })
      if (!res.ok) throw new Error(await res.text())
      onUpdate(await res.json())
      setEditing(false)
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = () => {
    setDraft({
      date: formatDate(transaction.date),
      description: transaction.description,
      absAmount: fromCents(Math.abs(transaction.amount)),
      transactionType: transaction.transactionType,
      category: transaction.category,
      status: transaction.status,
      notes: transaction.notes ?? '',
    })
    setError('')
    setEditing(false)
  }

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await deleteWithUndo(transaction, toast, onDelete, onRestore)
      setConfirmingDelete(false)
    } catch (e) {
      toast.error(`Could not delete transaction: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div
      className="p-3 space-y-2"
      style={{ borderBottom: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-card)' }}
    >
      <div className="flex items-start gap-2.5">
        {onToggleSelect && (
          <input
            type="checkbox"
            checked={!!selected}
            onChange={() => onToggleSelect(transaction.id)}
            className="mt-1 cursor-pointer shrink-0"
            aria-label={`Select transaction: ${transaction.description}`}
          />
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-mono shrink-0" style={{ color: 'var(--tx-tertiary)' }}>
              {formatDate(transaction.date)}
            </span>
            <span
              className="amount font-mono text-sm shrink-0"
              style={{ color: isExpense ? 'var(--tx-error)' : 'var(--tx-primary)', letterSpacing: '-0.275px' }}
            >
              {isExpense ? '-' : '+'}{transaction.account.currency} {fromCents(Math.abs(transaction.amount)).toFixed(2)}
            </span>
          </div>

          <p className="text-sm mt-0.5 truncate" style={{ color: 'var(--tx-primary)' }}>
            {transaction.description}
          </p>

          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            <Badge variant="info" pop>{transaction.category || 'Uncategorized'}</Badge>
            <Badge variant={statusCfg.variant} pop>{statusCfg.label}</Badge>
            {transaction.linkedTransferId && (
              <span title="Linked transfer" style={{ color: 'var(--tx-tertiary)' }}><Link2 size={12} /></span>
            )}
            {transaction.splitLegs && transaction.splitLegs.length > 0 && (
              <span title="Split transaction" style={{ color: 'var(--tx-tertiary)' }}><Scissors size={12} /></span>
            )}
            {transaction.account.name && (
              <span className="text-xs" style={{ color: 'var(--tx-faint)' }}>{transaction.account.name}</span>
            )}
          </div>
        </div>

        <button
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Row actions"
          className="shrink-0 p-1"
          style={{ color: 'var(--tx-tertiary)' }}
        >
          {menuOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
      </div>

      {menuOpen && !editing && (
        <div className="flex items-center gap-3 pl-6">
          <button
            onClick={() => { setEditing(true); setMenuOpen(false) }}
            className="btn text-xs transition-colors duration-150"
            style={{ color: 'var(--tx-secondary)' }}
          >
            Edit
          </button>
          <button
            onClick={() => setConfirmingDelete(true)}
            className="btn text-xs transition-colors duration-150 hover:text-error"
            style={{ color: 'var(--tx-tertiary)' }}
          >
            Delete
          </button>
        </div>
      )}

      {editing && (
        <div className="pl-6 pt-1 space-y-2 border-l" style={{ borderColor: 'var(--border-warm)' }}>
          <div className="flex gap-2 items-center flex-wrap">
            <DatePicker value={draft.date} onChange={(v) => setDraft((d) => ({ ...d, date: v }))} />
            <Select
              value={draft.transactionType}
              onValueChange={(v) => setDraft((d) => ({ ...d, transactionType: v }))}
              options={TYPE_OPTIONS}
              ariaLabel="Transaction type"
            />
          </div>
          <input
            type="text"
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
            className="w-full px-2 py-1.5 text-sm rounded-[6px] outline-none"
            style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }}
          />
          <div className="flex gap-2 items-center flex-wrap">
            <input
              type="number" min="0" step="0.01"
              value={draft.absAmount}
              onChange={(e) => setDraft((d) => ({ ...d, absAmount: Number(e.target.value) }))}
              className="w-24 px-2 py-1.5 text-sm rounded-[6px] outline-none font-mono"
              style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }}
            />
            <input
              type="text"
              value={draft.category}
              onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}
              placeholder="Category"
              list={`categories-${transaction.id}`}
              className="flex-1 min-w-[100px] px-2 py-1.5 text-sm rounded-[6px] outline-none"
              style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }}
            />
            <datalist id={`categories-${transaction.id}`}>
              {categories.map((c) => <option key={c.id} value={c.name} />)}
            </datalist>
          </div>
          <select
            value={draft.status}
            onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value }))}
            className="px-2 py-1.5 text-sm rounded-[6px] outline-none"
            style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }}
          >
            <option value="review">Review</option>
            <option value="committed">Committed</option>
            <option value="reconciled">Reconciled</option>
          </select>
          {error && <p className="text-xs" style={{ color: 'var(--tx-error)' }}>{error}</p>}
          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" onClick={handleSave} disabled={saving}>
              {saving ? '…' : 'Save'}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleCancel} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <Modal
        open={confirmingDelete}
        onClose={() => { if (!deleting) setConfirmingDelete(false) }}
        maxWidth={400}
        title="Delete transaction"
      >
        <p className="text-sm mb-5" style={{ color: 'var(--tx-secondary)' }}>
          Delete “{transaction.description}”? This cannot be undone.
        </p>
        <div className="flex items-center justify-end gap-3">
          <Button variant="ghost" size="sm" onClick={() => setConfirmingDelete(false)} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="danger" size="md" onClick={handleDelete} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </div>
      </Modal>
    </div>
  )
}
