'use client'

import { memo, useState } from 'react'
import { X, Link2, Unlink, Scissors, ChevronDown, ChevronRight, RotateCcw, CheckCircle2 } from 'lucide-react'
import { DatePicker } from '@/app/_components/DatePicker'
import { TransferLinkModal } from './TransferLinkModal'
import { ReimburseLinkModal } from './ReimburseLinkModal'
import { SplitForm } from './SplitForm'
import { Select, Badge, Button, Modal, CategoryDot, useToast } from '@/app/_components/ui'
import type { BadgeVariant } from '@/app/_components/ui'
import { fromCents, toCents } from '@/lib/money'
import { categoryColor } from '@/lib/category-colors'
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

type Account = { id: number; name: string; currency: string }
type Category = { id: number; name: string; color: string }

const inputStyle: React.CSSProperties = {
  border: '1px solid var(--border-warm)',
  backgroundColor: 'var(--bg-input)',
  color: 'var(--tx-primary)',
}

const fieldInputCls = 'w-full px-2 py-1.5 text-sm rounded-[6px] outline-none'
const labelCls = 'block text-[10px] font-medium uppercase tracking-wide mb-1'

const TYPE_OPTIONS = [
  { value: 'debit',    label: 'Debit',    dot: 'var(--tx-stat-expense)', color: 'var(--tx-stat-expense)' },
  { value: 'credit',   label: 'Credit',   dot: 'var(--tx-stat-income)',  color: 'var(--tx-stat-income)' },
  { value: 'transfer', label: 'Transfer', dot: 'var(--tx-transfer)',     color: 'var(--tx-transfer)' },
]

function TypeSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Select
      value={value}
      onValueChange={onChange}
      options={TYPE_OPTIONS}
      ariaLabel="Transaction type"
      showDot
      colorFromOption
    />
  )
}

function SimpleSelect({
  value,
  onChange,
  options,
  showDot = false,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string; dot?: string }[]
  showDot?: boolean
}) {
  return <Select value={value} onValueChange={onChange} options={options} showDot={showDot} />
}

function formatDate(d: string | Date) {
  return new Date(d).toISOString().split('T')[0]
}

// Keeps the checkbox's accessible name terse for long descriptions rather
// than reading out the whole thing through a screen reader.
function truncateForLabel(s: string, max = 40) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

const STATUS_BADGE: Record<string, { variant: BadgeVariant; label: string }> = {
  committed:  { variant: 'positive', label: 'Committed' },
  reconciled: { variant: 'info',     label: 'Reconciled' },
  review:     { variant: 'caution',  label: 'Review' },
}

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_BADGE[status] ?? STATUS_BADGE.review
  return <Badge variant={cfg.variant} pop>{cfg.label}</Badge>
}

function LedgerRowInner({
  transaction,
  accounts,
  categories,
  onUpdate,
  onUpdateById,
  onDelete,
  onRestore,
  selected,
  onToggleSelect,
}: {
  transaction: Transaction
  accounts: Account[]
  categories: Category[]
  onUpdate: (updated: Transaction) => void
  onUpdateById?: (id: number, patch: Partial<Transaction>) => void
  onDelete: (id: number) => void
  /** Called after a delete is undone, so the ledger can refetch and show the restored row. */
  onRestore?: () => void
  selected?: boolean
  onToggleSelect?: (id: number) => void
}) {
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')
  const [ruleSuggestion, setRuleSuggestion] = useState<{ description: string; category: string } | null>(null)
  const [rulePattern, setRulePattern] = useState('')
  const [ruleVendor, setRuleVendor] = useState('')
  const [ruleSaving, setRuleSaving] = useState(false)
  const [showLinkModal, setShowLinkModal] = useState(false)
  const [unlinking, setUnlinking] = useState(false)
  const [showSplitForm, setShowSplitForm] = useState(false)
  const [showSplitLegs, setShowSplitLegs] = useState(false)
  const [showReimburseModal, setShowReimburseModal] = useState(false)
  const [unlinkingReimburse, setUnlinkingReimburse] = useState(false)
  const [ruleMatchType, setRuleMatchType] = useState('contains')
  // Transfer direction: 'out' = money leaving (negative), 'in' = money entering (positive)
  const initDirection = (t: Transaction): 'in' | 'out' =>
    t.transactionType === 'transfer' && t.amount >= 0 ? 'in' : 'out'

  const [transferDirection, setTransferDirection] = useState<'in' | 'out'>(initDirection(transaction))
  // absAmount is kept in major units for the input UX; converted to cents on save.
  const [draft, setDraft] = useState({
    date: formatDate(transaction.date),
    description: transaction.description,
    absAmount: fromCents(Math.abs(transaction.amount)),
    transactionType: transaction.transactionType,
    category: transaction.category,
    accountId: transaction.accountId,
    status: transaction.status,
    notes: transaction.notes ?? '',
    reimbursableFor: transaction.reimbursableFor ?? '',
    transferCounterpartAccountId: transaction.transferCounterpartAccountId ?? null as number | null,
  })

  const set = (field: string, value: string | number | null) =>
    setDraft((prev) => ({ ...prev, [field]: value }))

  // Returns integer cents matching the API contract.
  const computeSignedAmount = () => {
    const absCents = toCents(Math.abs(draft.absAmount))
    if (draft.transactionType === 'debit') return -absCents
    if (draft.transactionType === 'credit') return absCents
    // transfer
    return transferDirection === 'in' ? absCents : -absCents
  }

  const handleSave = async () => {
    setSaving(true)
    setError('')
    const signedAmount = computeSignedAmount()
    try {
      const res = await fetch(`/api/transactions/${transaction.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...draft,
          amount: signedAmount,
          reimbursableFor: draft.reimbursableFor || null,
          transferCounterpartAccountId: draft.transactionType === 'transfer'
            ? (draft.transferCounterpartAccountId ?? null)
            : null,
        }),
      })
      if (!res.ok) throw new Error(await res.text())
      onUpdate(await res.json())
      setEditing(false)
      const rawDesc = transaction.originalDescription ?? draft.description
      fetch(`/api/vendor-rules/check?description=${encodeURIComponent(rawDesc)}&amount=${signedAmount}`)
        .then((r) => r.json())
        .then(({ matched }) => {
          if (!matched) {
            setRuleSuggestion({ description: draft.description, category: draft.category })
            setRulePattern(rawDesc)
            setRuleVendor(draft.description)
          }
        })
        .catch(() => { /* non-critical */ })
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
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

  const handleCancel = () => {
    setTransferDirection(initDirection(transaction))
    setDraft({
      date: formatDate(transaction.date),
      description: transaction.description,
      absAmount: fromCents(Math.abs(transaction.amount)),
      transactionType: transaction.transactionType,
      category: transaction.category,
      accountId: transaction.accountId,
      status: transaction.status,
      notes: transaction.notes ?? '',
      reimbursableFor: transaction.reimbursableFor ?? '',
      transferCounterpartAccountId: transaction.transferCounterpartAccountId ?? null,
    })
    setError('')
    setRuleSuggestion(null)
    setEditing(false)
  }

  const handleCreateRule = async () => {
    if (!ruleSuggestion) return
    setRuleSaving(true)
    try {
      const res = await fetch('/api/vendor-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pattern: rulePattern,
          vendor: ruleVendor,
          category: ruleSuggestion.category,
          matchType: ruleMatchType,
          direction: computeSignedAmount() < 0 ? 'debit' : computeSignedAmount() > 0 ? 'credit' : 'either',
        }),
      })
      if (!res.ok) throw new Error(await res.text())
      setRuleSuggestion(null)
      toast.success(`Rule created for “${ruleVendor}”`)
    } catch (e) {
      toast.error(`Could not create rule: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRuleSaving(false)
    }
  }

  const handleUnlink = async () => {
    setUnlinking(true)
    try {
      const res = await fetch(`/api/transactions/${transaction.id}/link`, { method: 'DELETE' })
      if (!res.ok) throw new Error(await res.text())
      const updated = await res.json()
      if (transaction.linkedTransferId) {
        onUpdateById?.(transaction.linkedTransferId, { linkedTransferId: null })
      }
      onUpdate(updated)
      toast.success('Transfer unlinked')
    } catch (e) {
      toast.error(`Could not unlink transfer: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setUnlinking(false)
    }
  }

  const handleUnlinkReimbursement = async () => {
    const prevSettlementId = transaction.reimbursementTxId
    setUnlinkingReimburse(true)
    try {
      const res = await fetch(`/api/transactions/${transaction.id}/reimburse`, { method: 'DELETE' })
      if (!res.ok) throw new Error(await res.text())
      const updated = await res.json()
      onUpdate(updated)
      if (prevSettlementId) {
        onUpdateById?.(prevSettlementId, { reimbursedExpense: null })
      }
      toast.success('Reimbursement unlinked')
    } catch (e) {
      toast.error(`Could not unlink reimbursement: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setUnlinkingReimburse(false)
    }
  }

  const isTransfer = transaction.transactionType === 'transfer'
  const amtColor = (amt: number) =>
    isTransfer ? 'var(--tx-transfer)' : amt < 0 ? 'var(--tx-error)' : amt > 0 ? 'var(--tx-success)' : 'var(--tx-faint)'

  const currency =
    accounts.find((a) => a.id === transaction.accountId)?.currency ?? transaction.account.currency

  const rowBorder: React.CSSProperties = { borderTop: '1px solid var(--border-warm)' }

  // Both sides are integer cents; sum is cents.
  const netAmount = transaction.reimbursementTx
    ? transaction.amount + transaction.reimbursementTx.amount
    : null
  const fmtMoney = (cents: number) => fromCents(Math.abs(cents)).toFixed(2)

  // ── Shared rule suggestion strip ──────────────────────────────────────────────
  const ruleSuggestionRow = ruleSuggestion ? (
    <tr>
      <td colSpan={8} className="px-3 py-2.5" style={{ backgroundColor: 'var(--bg-card-alt)', borderTop: '1px solid var(--border-warm)' }}>
        <div className="space-y-2">
          {/* Row 1: summary + actions */}
          <div className="flex items-center gap-2 text-xs">
            <span className="font-medium" style={{ color: 'var(--tx-secondary)' }}>Save vendor rule</span>
            <span className="px-1.5 py-0.5 rounded-[4px]" style={{ backgroundColor: 'var(--bg-badge-committed)', color: 'var(--tx-badge-committed)' }}>
              {ruleSuggestion.category}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <button onClick={handleCreateRule} disabled={ruleSaving} className="btn px-2.5 py-0.5 rounded-[4px] text-xs font-medium disabled:opacity-40" style={{ backgroundColor: 'var(--bg-btn)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}>
                {ruleSaving ? '…' : 'Save'}
              </button>
              <button onClick={() => setRuleSuggestion(null)} className="transition-opacity hover:opacity-60" style={{ color: 'var(--tx-tertiary)' }}><X size={11} /></button>
            </div>
          </div>
          {/* Row 2: editable fields */}
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="text" value={rulePattern} onChange={(e) => setRulePattern(e.target.value)}
              placeholder="Pattern"
              className="flex-1 min-w-0 px-2 py-1 text-xs rounded-[4px] outline-none font-mono"
              style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }}
              title="Text pattern to match against transaction descriptions"
            />
            <input
              type="text" value={ruleVendor} onChange={(e) => setRuleVendor(e.target.value)}
              placeholder="Vendor name"
              className="w-32 px-2 py-1 text-xs rounded-[4px] outline-none"
              style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }}
              title="Display name for this vendor"
            />
            <Select
              value={ruleMatchType}
              onValueChange={setRuleMatchType}
              options={['contains', 'starts-with', 'ends-with', 'exact', 'regex'].map((mt) => ({ value: mt, label: mt }))}
              size="xs"
              fullWidth={false}
              className="whitespace-nowrap"
              ariaLabel="How to match the pattern"
            />
          </div>
        </div>
      </td>
    </tr>
  ) : null

  // ── Edit mode: full-width drawer ──────────────────────────────────────────────
  if (editing) {
    const reimbursableChecked = !!draft.reimbursableFor
    return (
      <>
        <tr style={{ ...rowBorder, backgroundColor: 'var(--bg-edit-row)' }}>
          <td colSpan={8} className="px-4 pt-4 pb-5">
            <div className="space-y-4">

              {/* Row 1: Date · Description · Amount · Type */}
              <div className="flex flex-wrap gap-3 items-end">
                <div style={{ minWidth: '130px' }}>
                  <label className={labelCls} style={{ color: 'var(--tx-tertiary)' }}>Date</label>
                  <DatePicker
                    value={draft.date}
                    onChange={(v) => set('date', v)}
                    style={{ width: '100%' }}
                  />
                </div>
                <div className="flex-1" style={{ minWidth: '220px' }}>
                  <label className={labelCls} style={{ color: 'var(--tx-tertiary)' }}>Description</label>
                  <input
                    type="text" value={draft.description}
                    onChange={(e) => set('description', e.target.value)}
                    className={fieldInputCls}
                    style={inputStyle}
                  />
                </div>
                <div style={{ minWidth: '120px' }}>
                  <label className={labelCls} style={{ color: 'var(--tx-tertiary)' }}>Amount</label>
                  <input
                    type="number" step="0.01" min="0" value={draft.absAmount}
                    onChange={(e) => set('absAmount', Math.abs(parseFloat(e.target.value) || 0))}
                    className={`${fieldInputCls} font-mono`}
                    style={{ ...inputStyle, color: amtColor(computeSignedAmount()) }}
                  />
                </div>
                <div style={{ minWidth: '110px' }}>
                  <label className={labelCls} style={{ color: 'var(--tx-tertiary)' }}>Type</label>
                  <TypeSelect
                    value={draft.transactionType}
                    onChange={(v) => {
                      set('transactionType', v)
                      if (v !== 'transfer') set('transferCounterpartAccountId', null)
                    }}
                  />
                </div>
                {draft.transactionType === 'transfer' && (
                  <>
                    <div style={{ minWidth: '90px' }}>
                      <label className={labelCls} style={{ color: 'var(--tx-tertiary)' }}>Direction</label>
                      <SimpleSelect
                        value={transferDirection}
                        onChange={(v) => setTransferDirection(v as 'in' | 'out')}
                        options={[
                          { value: 'out', label: '↑ Out' },
                          { value: 'in',  label: '↓ In' },
                        ]}
                      />
                    </div>
                    <div style={{ minWidth: '150px' }}>
                      <label className={labelCls} style={{ color: 'var(--tx-tertiary)' }}>
                        {transferDirection === 'out' ? 'To account' : 'From account'}
                      </label>
                      <SimpleSelect
                        value={String(draft.transferCounterpartAccountId ?? '__none__')}
                        onChange={(v) => set('transferCounterpartAccountId', v === '__none__' ? null : parseInt(v))}
                        options={[
                          { value: '__none__', label: '— none —' },
                          ...accounts
                            .filter((a) => a.id !== draft.accountId)
                            .map((a) => ({ value: String(a.id), label: a.name })),
                        ]}
                      />
                    </div>
                  </>
                )}
              </div>

              {/* Row 2: Category · Account · Status · Notes */}
              <div className="flex flex-wrap gap-3 items-end">
                <div style={{ minWidth: '150px' }}>
                  <label className={labelCls} style={{ color: 'var(--tx-tertiary)' }}>Category</label>
                  <SimpleSelect
                    value={draft.category}
                    onChange={(v) => set('category', v)}
                    showDot
                    options={[
                      ...categories.map((c) => ({ value: c.name, label: c.name, dot: c.color })),
                      ...(!categories.find((c) => c.name === draft.category) && draft.category
                        ? [{ value: draft.category, label: draft.category, dot: categoryColor(draft.category, categories) }]
                        : []),
                    ]}
                  />
                </div>
                <div style={{ minWidth: '150px' }}>
                  <label className={labelCls} style={{ color: 'var(--tx-tertiary)' }}>Account</label>
                  <SimpleSelect
                    value={String(draft.accountId)}
                    onChange={(v) => set('accountId', parseInt(v))}
                    options={accounts.map((a) => ({ value: String(a.id), label: a.name }))}
                  />
                </div>
                <div style={{ minWidth: '130px' }}>
                  <label className={labelCls} style={{ color: 'var(--tx-tertiary)' }}>Status</label>
                  <SimpleSelect
                    value={draft.status}
                    onChange={(v) => set('status', v)}
                    options={[
                      { value: 'review', label: 'Review' },
                      { value: 'committed', label: 'Committed' },
                      { value: 'reconciled', label: 'Reconciled' },
                    ]}
                  />
                </div>
                <div className="flex-1" style={{ minWidth: '200px' }}>
                  <label className={labelCls} style={{ color: 'var(--tx-tertiary)' }}>Notes</label>
                  <input
                    type="text" value={draft.notes} placeholder="Optional"
                    onChange={(e) => set('notes', e.target.value)}
                    className={fieldInputCls}
                    style={inputStyle}
                  />
                </div>
              </div>

              {/* Row 3: Reimbursable */}
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id={`reimb-${transaction.id}`}
                  checked={reimbursableChecked}
                  onChange={(e) => set('reimbursableFor', e.target.checked ? 'Insurance' : '')}
                  className="cursor-pointer"
                />
                {reimbursableChecked ? (
                  <input
                    type="text"
                    value={draft.reimbursableFor}
                    onChange={(e) => set('reimbursableFor', e.target.value)}
                    placeholder="Reimbursed by…"
                    className="px-2 py-1 text-sm rounded-[4px] outline-none"
                    style={{ ...inputStyle, width: '180px' }}
                  />
                ) : (
                  <label
                    htmlFor={`reimb-${transaction.id}`}
                    className="text-xs cursor-pointer select-none"
                    style={{ color: 'var(--tx-faint)' }}
                  >
                    Mark as reimbursable
                  </label>
                )}
              </div>

              {/* Row 4: Actions */}
              <div className="flex items-center gap-3 pt-1 border-t" style={{ borderColor: 'var(--border-warm)' }}>
                <Button variant="primary" size="sm" onClick={handleSave} disabled={saving}>
                  {saving ? '…' : 'Save'}
                </Button>
                <Button variant="ghost" size="sm" onClick={handleCancel}>
                  Cancel
                </Button>
                {error && <span className="text-xs" style={{ color: 'var(--tx-error)' }}>{error}</span>}
              </div>

            </div>
          </td>
        </tr>
        {ruleSuggestionRow}
        {showLinkModal && (
          <TransferLinkModal
            transactionId={transaction.id}
            transactionAmount={transaction.amount}
            transactionDate={transaction.date}
            onLink={(targetId, updatedTx) => {
              onUpdate(updatedTx as Transaction)
              onUpdateById?.(targetId, { linkedTransferId: transaction.id })
              setShowLinkModal(false)
            }}
            onClose={() => setShowLinkModal(false)}
          />
        )}
        {showReimburseModal && (
          <ReimburseLinkModal
            expenseId={transaction.id}
            expenseDescription={transaction.description}
            expenseAmount={transaction.amount}
            onLink={(settlementId, updatedExpense) => {
              onUpdate(updatedExpense as Transaction)
              onUpdateById?.(settlementId, { reimbursedExpense: { id: transaction.id, description: transaction.description } })
              setShowReimburseModal(false)
            }}
            onClose={() => setShowReimburseModal(false)}
          />
        )}
      </>
    )
  }

  // ── Read mode ─────────────────────────────────────────────────────────────────

  return (
    <>
      <tr
        className="group row-hover transition-colors duration-100"
        style={{ ...rowBorder, cursor: 'default' }}
      >
        {/* 1 · Checkbox */}
        <td className="px-3 py-3 w-10">
          <input
            type="checkbox"
            checked={!!selected}
            onChange={() => onToggleSelect?.(transaction.id)}
            className="cursor-pointer"
            aria-label={`Select transaction: ${truncateForLabel(transaction.description)}`}
          />
        </td>

        {/* 2 · Date */}
        <td className="px-3 py-3 whitespace-nowrap text-sm" style={{ color: 'var(--tx-secondary)' }}>
          {formatDate(transaction.date)}
        </td>

        {/* 3 · Description + original + notes + indicators */}
        <td className="px-3 py-3 max-w-xs">
          <div className="min-w-0">
            <div className="text-sm truncate" style={{ color: 'var(--tx-primary)' }}>
              {transaction.description}
            </div>
            {transaction.originalDescription && transaction.originalDescription !== transaction.description && (
              <div
                className="text-xs truncate mt-0.5"
                style={{ color: 'var(--tx-faint)' }}
                title={transaction.originalDescription}
              >
                {transaction.originalDescription}
              </div>
            )}
            {transaction.notes && (
              <div className="text-xs truncate mt-0.5 italic" style={{ color: 'var(--tx-faint)' }}>
                {transaction.notes}
              </div>
            )}
            {(transaction.linkedTransferId ||
              transaction.transactionType === 'transfer' ||
              (transaction.reimbursableFor && !transaction.reimbursementTxId) ||
              transaction.reimbursementTx ||
              transaction.reimbursedExpense) && (
              <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                {transaction.transactionType === 'transfer' && (
                  <Badge variant="transfer" shape="tag">
                    {transaction.amount < 0 ? '↑ out' : '↓ in'}
                    {transaction.transferCounterpartAccount && (
                      <> · {transaction.transferCounterpartAccount.name}</>
                    )}
                  </Badge>
                )}
                {transaction.linkedTransferId && (
                  <span
                    className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] rounded-[4px]"
                    title="Linked transfer"
                    style={{ backgroundColor: 'var(--bg-card-alt)', color: 'var(--tx-tertiary)' }}
                  >
                    <Link2 size={9} />
                    linked
                  </span>
                )}
                {transaction.reimbursableFor && !transaction.reimbursementTxId && (
                  <Badge
                    variant="transfer"
                    shape="tag"
                    title={`Pending reimbursement from ${transaction.reimbursableFor}`}
                  >
                    <RotateCcw size={9} />
                    reimbursement pending
                  </Badge>
                )}
                {transaction.reimbursementTx && (
                  <span
                    className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] rounded-[4px]"
                    title={`Reimbursed: ${transaction.reimbursementTx.description}`}
                    style={{ backgroundColor: 'var(--bg-badge-committed)', color: 'var(--tx-badge-committed)' }}
                  >
                    <CheckCircle2 size={9} />
                    reimbursed
                  </span>
                )}
                {transaction.reimbursedExpense && (
                  <span
                    className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] rounded-[4px]"
                    title={`Reimburses: ${transaction.reimbursedExpense.description}`}
                    style={{ backgroundColor: 'var(--bg-badge-committed)', color: 'var(--tx-badge-committed)' }}
                  >
                    <RotateCcw size={9} />
                    reimburses
                  </span>
                )}
              </div>
            )}
          </div>
        </td>

        {/* 4 · Amount */}
        <td className="px-3 py-3 amount whitespace-nowrap" style={{ letterSpacing: '-0.275px' }}>
          <div className="text-sm" style={{ color: amtColor(transaction.amount) }}>
            {transaction.amount < 0 ? '−' : '+'}{currency}{fmtMoney(transaction.amount)}
          </div>
          {netAmount !== null && (
            <div className="text-[10px] font-normal mt-0.5" style={{ color: 'var(--tx-secondary)', letterSpacing: 0 }}>
              net {netAmount < 0 ? '−' : '+'}{currency}{fmtMoney(netAmount)}
            </div>
          )}
        </td>

        {/* 5 · Category (or split toggle) */}
        <td className="px-3 py-3 text-sm" style={{ color: 'var(--tx-secondary)' }}>
          {transaction.splitLegs && transaction.splitLegs.length > 0 ? (
            <button
              onClick={() => setShowSplitLegs((v) => !v)}
              className="btn flex items-center gap-1 text-sm"
              style={{ color: 'var(--tx-secondary)' }}
            >
              {showSplitLegs ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              Split ×{transaction.splitLegs.length}
            </button>
          ) : transaction.category ? (
            <span className="flex items-center gap-1.5">
              <CategoryDot color={categoryColor(transaction.category, categories)} />
              {transaction.category}
            </span>
          ) : (
            <span style={{ color: 'var(--tx-faint)' }}>—</span>
          )}
        </td>

        {/* 6 · Account */}
        <td className="px-3 py-3 text-xs whitespace-nowrap" style={{ color: 'var(--tx-faint)' }}>
          {transaction.account.name}
        </td>

        {/* 7 · Status */}
        <td className="px-3 py-3">
          <StatusBadge status={transaction.status} />
        </td>

        {/* 8 · Actions (hover-reveal) */}
        <td className="px-3 py-3">
          <div className="flex items-center gap-2 opacity-40 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-150">
            <button
              onClick={() => setEditing(true)}
              className="btn text-xs transition-colors duration-150 hover:text-accent"
              style={{ color: 'var(--tx-tertiary)' }}
              aria-label="Edit"
            >
              Edit
            </button>
            {transaction.linkedTransferId ? (
              <button
                onClick={handleUnlink} disabled={unlinking}
                className="text-xs transition-colors duration-150 hover:text-error disabled:opacity-40"
                style={{ color: 'var(--tx-tertiary)' }}
                title="Unlink transfer"
                aria-label="Unlink transfer"
              >
                <Unlink size={13} />
              </button>
            ) : (
              <button
                onClick={() => setShowLinkModal(true)}
                className="text-xs transition-colors duration-150 hover:text-accent"
                style={{ color: 'var(--tx-tertiary)' }}
                title="Link as transfer"
                aria-label="Link as transfer"
              >
                <Link2 size={13} />
              </button>
            )}
            {transaction.reimbursableFor && (
              transaction.reimbursementTxId ? (
                <button
                  onClick={handleUnlinkReimbursement} disabled={unlinkingReimburse}
                  className="text-xs transition-colors duration-150 hover:text-error disabled:opacity-40"
                  style={{ color: 'var(--tx-tertiary)' }}
                  title="Unlink reimbursement"
                  aria-label="Unlink reimbursement"
                >
                  <Unlink size={13} />
                </button>
              ) : (
                <button
                  onClick={() => setShowReimburseModal(true)}
                  className="text-xs transition-colors duration-150 hover:text-accent"
                  style={{ color: 'var(--tx-tertiary)' }}
                  title="Link reimbursement transaction"
                  aria-label="Link reimbursement transaction"
                >
                  <RotateCcw size={13} />
                </button>
              )
            )}
            {!transaction.parentTransactionId && (
              <button
                onClick={() => setShowSplitForm((v) => !v)}
                className="text-xs transition-colors duration-150 hover:text-accent"
                style={{ color: showSplitForm ? 'var(--tx-secondary)' : 'var(--tx-tertiary)' }}
                title="Split transaction"
                aria-label="Split transaction"
              >
                <Scissors size={13} />
              </button>
            )}
            <button
              onClick={() => setConfirmingDelete(true)}
              className="text-xs transition-colors duration-150 hover:text-error ml-1 pl-1"
              style={{ color: 'var(--tx-tertiary)', borderLeft: '1px solid var(--border-warm)' }}
              aria-label="Delete"
            >
              <X size={14} />
            </button>
          </div>
        </td>
      </tr>

      {/* Delete confirmation — replaces the old native browser dialog */}
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

      {/* Split form */}
      {showSplitForm && (
        <SplitForm
          parentId={transaction.id}
          parentAmount={transaction.amount}
          parentDescription={transaction.description}
          parentCategory={transaction.category}
          categories={categories}
          onSave={(updated) => { onUpdate(updated as Transaction); setShowSplitForm(false); setShowSplitLegs(true) }}
          onCancel={() => setShowSplitForm(false)}
        />
      )}

      {/* Split legs */}
      {showSplitLegs && transaction.splitLegs && transaction.splitLegs.map((leg) => (
        <tr key={leg.id} style={{ borderTop: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-surface-200)' }}>
          <td className="w-10" />
          <td />
          <td
            className="px-3 py-2.5 pl-10 text-sm"
            style={{ color: 'var(--tx-faint)', borderLeft: '2px solid var(--border-warm)' }}
          >
            {leg.description}
          </td>
          <td className="px-3 py-2.5 text-sm amount whitespace-nowrap" style={{ color: amtColor(leg.amount), letterSpacing: '-0.275px' }}>
            {leg.amount < 0 ? '−' : '+'}{currency}{fmtMoney(leg.amount)}
          </td>
          <td className="px-3 py-2.5 text-sm" style={{ color: 'var(--tx-faint)' }}>
            {leg.category && (
              <span className="flex items-center gap-1.5">
                <CategoryDot color={categoryColor(leg.category, categories)} />
                {leg.category}
              </span>
            )}
          </td>
          <td colSpan={3} />
        </tr>
      ))}

      {ruleSuggestionRow}

      {showLinkModal && (
        <TransferLinkModal
          transactionId={transaction.id}
          transactionAmount={transaction.amount}
          transactionDate={transaction.date}
          onLink={(targetId, updatedTx) => {
            onUpdate(updatedTx as Transaction)
            onUpdateById?.(targetId, { linkedTransferId: transaction.id })
            setShowLinkModal(false)
          }}
          onClose={() => setShowLinkModal(false)}
        />
      )}
      {showReimburseModal && (
        <ReimburseLinkModal
          expenseId={transaction.id}
          expenseDescription={transaction.description}
          expenseAmount={transaction.amount}
          onLink={(settlementId, updatedExpense) => {
            onUpdate(updatedExpense as Transaction)
            onUpdateById?.(settlementId, {
              reimbursedExpense: { id: transaction.id, description: transaction.description },
            })
            setShowReimburseModal(false)
          }}
          onClose={() => setShowReimburseModal(false)}
        />
      )}
    </>
  )
}

// Rows re-render often as the ledger refetches, but an unchanged row (same
// transaction reference, same `selected` flag) need not. All handlers passed
// in are stable (`useCallback` in LedgerView), and select/update/delete are
// id-based, so React.memo's shallow prop comparison is safe here.
export const LedgerRow = memo(LedgerRowInner)
