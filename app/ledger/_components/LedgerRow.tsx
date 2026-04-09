'use client'

import { useState } from 'react'
import { X, Link2, Unlink, Scissors, ChevronDown, ChevronRight, RotateCcw, CheckCircle2 } from 'lucide-react'
import { TransferLinkModal } from './TransferLinkModal'
import { ReimburseLinkModal } from './ReimburseLinkModal'
import { SplitForm } from './SplitForm'

type SplitLeg = { id: number; amount: number; category: string; description: string }

type Transaction = {
  id: number
  date: string | Date
  amount: number
  description: string
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
}

type Account = { id: number; name: string; currency: string }
type Category = { id: number; name: string; color: string }

const inputCls =
  'w-full px-2 py-1 text-xs rounded-[6px] outline-none transition-colors duration-150'

const inputStyle: React.CSSProperties = {
  border: '1px solid var(--border-warm)',
  backgroundColor: 'var(--bg-input)',
  color: 'var(--tx-primary)',
}

function formatDate(d: string | Date) {
  return new Date(d).toISOString().split('T')[0]
}

function StatusBadge({ status }: { status: string }) {
  const cfg =
    status === 'committed'
      ? { bg: 'var(--bg-badge-committed)', tx: 'var(--tx-badge-committed)', label: 'Committed' }
      : status === 'reconciled'
      ? { bg: 'var(--bg-badge-reconciled)', tx: 'var(--tx-badge-reconciled)', label: 'Reconciled' }
      : { bg: 'var(--bg-badge-review)', tx: 'var(--tx-badge-review)', label: 'Review' }
  return (
    <span
      className="badge-pop inline-flex items-center px-2 py-0.5 rounded-full text-xs"
      style={{ backgroundColor: cfg.bg, color: cfg.tx }}
    >
      {cfg.label}
    </span>
  )
}

export function LedgerRow({
  transaction,
  accounts,
  categories,
  onUpdate,
  onUpdateById,
  onDelete,
  selected,
  onToggleSelect,
}: {
  transaction: Transaction
  accounts: Account[]
  categories: Category[]
  onUpdate: (updated: Transaction) => void
  onUpdateById?: (id: number, patch: Partial<Transaction>) => void
  onDelete: (id: number) => void
  selected?: boolean
  onToggleSelect?: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
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
  const [draft, setDraft] = useState({
    date: formatDate(transaction.date),
    description: transaction.description,
    amount: transaction.amount,
    category: transaction.category,
    accountId: transaction.accountId,
    status: transaction.status,
    notes: transaction.notes ?? '',
    reimbursableFor: transaction.reimbursableFor ?? '',
  })

  const set = (field: string, value: string | number) =>
    setDraft((prev) => ({ ...prev, [field]: value }))

  const handleSave = async () => {
    setSaving(true)
    setError('')
    try {
      const res = await fetch(`/api/transactions/${transaction.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draft, reimbursableFor: draft.reimbursableFor || null }),
      })
      if (!res.ok) throw new Error(await res.text())
      onUpdate(await res.json())
      setEditing(false)
      // Non-blocking vendor rule suggestion check
      fetch(`/api/vendor-rules/check?description=${encodeURIComponent(draft.description)}&amount=${draft.amount}`)
        .then((r) => r.json())
        .then(({ matched }) => {
          if (!matched) {
            setRuleSuggestion({ description: draft.description, category: draft.category })
            setRulePattern(draft.description)
            setRuleVendor(draft.description.split(' ').slice(0, 3).join(' '))
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
    if (!confirm('Delete this transaction?')) return
    try {
      await fetch(`/api/transactions/${transaction.id}`, { method: 'DELETE' })
      onDelete(transaction.id)
    } catch (e) {
      alert(String(e))
    }
  }

  const handleCancel = () => {
    setDraft({
      date: formatDate(transaction.date),
      description: transaction.description,
      amount: transaction.amount,
      category: transaction.category,
      accountId: transaction.accountId,
      status: transaction.status,
      notes: transaction.notes ?? '',
      reimbursableFor: transaction.reimbursableFor ?? '',
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
          direction: draft.amount < 0 ? 'debit' : draft.amount > 0 ? 'credit' : 'either',
        }),
      })
      if (!res.ok) throw new Error(await res.text())
      setRuleSuggestion(null)
    } catch { /* silent */ } finally {
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
    } catch { /* silent */ } finally {
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
    } catch { /* silent */ } finally {
      setUnlinkingReimburse(false)
    }
  }

  const isTransfer = transaction.category === 'Transfer'
  const amtColor = (amt: number) =>
    isTransfer ? '#F59E0B' : amt < 0 ? 'var(--tx-error)' : amt > 0 ? 'var(--tx-success)' : 'var(--tx-faint)'

  const currency =
    accounts.find((a) => a.id === transaction.accountId)?.currency ?? transaction.account.currency

  const rowBorder: React.CSSProperties = { borderTop: '1px solid var(--border-warm)' }

  const netAmount = transaction.reimbursementTx
    ? transaction.amount + transaction.reimbursementTx.amount
    : null

  if (editing) {
    const reimbursableChecked = !!draft.reimbursableFor
    return (
      <>
        <tr style={{ ...rowBorder, backgroundColor: 'var(--bg-edit-row)' }}>
          <td className="px-3 py-2 w-8" />
          <td className="px-2 py-2 min-w-[120px]">
            <input type="date" value={draft.date} onChange={(e) => set('date', e.target.value)} className={inputCls} style={inputStyle} />
          </td>
          <td className="px-2 py-2 min-w-[200px]">
            <input type="text" value={draft.description} onChange={(e) => set('description', e.target.value)} className={inputCls} style={inputStyle} />
          </td>
          <td className="px-2 py-2 min-w-[110px]">
            <input
              type="number" step="0.01" value={draft.amount}
              onChange={(e) => set('amount', parseFloat(e.target.value) || 0)}
              className={`${inputCls} font-mono`}
              style={{ ...inputStyle, color: amtColor(draft.amount) }}
            />
          </td>
          <td className="px-2 py-2 min-w-[130px]">
            <select value={draft.category} onChange={(e) => set('category', e.target.value)} className={inputCls} style={inputStyle}>
              {categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
              {!categories.find((c) => c.name === draft.category) && (
                <option value={draft.category}>{draft.category}</option>
              )}
            </select>
          </td>
          <td className="px-2 py-2 min-w-[140px]">
            <select value={draft.accountId} onChange={(e) => set('accountId', parseInt(e.target.value))} className={inputCls} style={inputStyle}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </td>
          <td className="px-2 py-2 min-w-[110px]">
            <select value={draft.status} onChange={(e) => set('status', e.target.value)} className={inputCls} style={inputStyle}>
              <option value="review">Review</option>
              <option value="committed">Committed</option>
              <option value="reconciled">Reconciled</option>
            </select>
          </td>
          <td className="px-2 py-2 min-w-[160px]">
            <input type="text" value={draft.notes} placeholder="Optional" onChange={(e) => set('notes', e.target.value)} className={inputCls} style={inputStyle} />
            {/* Reimbursable toggle */}
            <div className="flex items-center gap-1.5 mt-1.5">
              <input
                type="checkbox"
                id={`reimb-${transaction.id}`}
                checked={reimbursableChecked}
                onChange={(e) =>
                  set('reimbursableFor', e.target.checked ? 'Insurance' : '')
                }
                className="cursor-pointer"
              />
              {reimbursableChecked ? (
                <input
                  type="text"
                  value={draft.reimbursableFor}
                  onChange={(e) => set('reimbursableFor', e.target.value)}
                  placeholder="Reimbursed by…"
                  className="flex-1 px-1.5 py-0.5 text-[11px] rounded-[4px] outline-none"
                  style={inputStyle}
                />
              ) : (
                <label
                  htmlFor={`reimb-${transaction.id}`}
                  className="text-[11px] cursor-pointer select-none"
                  style={{ color: 'var(--tx-faint)' }}
                >
                  Reimbursable
                </label>
              )}
            </div>
          </td>
          <td className="px-2 py-2 whitespace-nowrap">
            <div className="flex items-center gap-2">
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-3 py-1 rounded-[6px] text-xs font-semibold transition-colors duration-150 hover:text-error disabled:opacity-40"
                style={{ backgroundColor: 'var(--bg-btn)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}
              >
                {saving ? '…' : 'Save'}
              </button>
              <button
                onClick={handleCancel}
                className="px-3 py-1 rounded-[6px] text-xs transition-colors duration-150 hover:text-error"
                style={{ color: 'var(--tx-secondary)', border: '1px solid var(--border-warm)' }}
              >
                Cancel
              </button>
            </div>
          </td>
        </tr>
        {error && (
          <tr>
            <td colSpan={9} className="px-3 py-1 text-xs" style={{ color: 'var(--tx-notify-error)', backgroundColor: 'var(--bg-notify-error)' }}>
              {error}
            </td>
          </tr>
        )}
      </>
    )
  }

  const suggestionBanner = ruleSuggestion && !editing ? (
    <tr>
      <td colSpan={9} className="px-3 py-2" style={{ backgroundColor: 'var(--bg-badge-review)', borderTop: '1px solid var(--border-warm)' }}>
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span style={{ color: 'var(--tx-badge-review)' }}>No vendor rule matches this description. Create one?</span>
          <input
            type="text"
            value={rulePattern}
            onChange={(e) => setRulePattern(e.target.value)}
            placeholder="Pattern"
            className="px-2 py-0.5 rounded-[4px] text-xs outline-none w-48"
            style={inputStyle}
          />
          <input
            type="text"
            value={ruleVendor}
            onChange={(e) => setRuleVendor(e.target.value)}
            placeholder="Vendor name"
            className="px-2 py-0.5 rounded-[4px] text-xs outline-none w-32"
            style={inputStyle}
          />
          <select
            value={ruleMatchType}
            onChange={(e) => setRuleMatchType(e.target.value)}
            className="px-1.5 py-0.5 rounded-[4px] text-xs outline-none"
            style={inputStyle}
            title="Match type"
          >
            <option value="contains">contains</option>
            <option value="starts-with">starts-with</option>
            <option value="ends-with">ends-with</option>
            <option value="exact">exact</option>
            <option value="regex">regex</option>
          </select>
          <button
            onClick={handleCreateRule}
            disabled={ruleSaving}
            className="px-2 py-0.5 rounded-[4px] text-xs disabled:opacity-40"
            style={{ backgroundColor: 'var(--bg-btn)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}
          >
            {ruleSaving ? '…' : 'Add Rule'}
          </button>
          <button onClick={() => setRuleSuggestion(null)} style={{ color: 'var(--tx-tertiary)' }}>
            <X size={12} />
          </button>
        </div>
      </td>
    </tr>
  ) : null

  return (
    <>
    <tr className="group transition-colors duration-100" style={{ ...rowBorder, cursor: 'default' }}
      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-row-hover)')}
      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
    >
      <td className="px-3 py-2.5 w-8">
        <input
          type="checkbox"
          checked={!!selected}
          onChange={onToggleSelect}
          className="cursor-pointer"
        />
      </td>
      <td className="px-3 py-2.5 text-xs whitespace-nowrap" style={{ color: 'var(--tx-secondary)' }}>
        {formatDate(transaction.date)}
      </td>
      <td className="px-3 py-2.5 text-sm max-w-xs" style={{ color: 'var(--tx-primary)' }}>
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="truncate">{transaction.description}</span>
          {transaction.linkedTransferId && (
            <span title="Linked transfer"><Link2 size={11} style={{ color: 'var(--tx-faint)', flexShrink: 0 }} /></span>
          )}
          {transaction.reimbursableFor && !transaction.reimbursementTxId && (
            <span title={`Pending reimbursement from ${transaction.reimbursableFor}`}>
              <RotateCcw size={11} style={{ color: 'var(--tx-faint)', flexShrink: 0 }} />
            </span>
          )}
          {transaction.reimbursementTx && (
            <span title={`Reimbursed: ${transaction.reimbursementTx.description}`}>
              <CheckCircle2 size={11} style={{ color: 'var(--tx-success)', flexShrink: 0 }} />
            </span>
          )}
          {transaction.reimbursedExpense && (
            <span title={`Reimburses: ${transaction.reimbursedExpense.description}`}>
              <RotateCcw size={11} style={{ color: 'var(--tx-success)', flexShrink: 0 }} />
            </span>
          )}
        </div>
      </td>
      <td className="px-3 py-2.5 text-sm font-mono whitespace-nowrap" style={{ letterSpacing: '-0.275px' }}>
        <div style={{ color: amtColor(transaction.amount) }}>
          {transaction.amount < 0 ? '−' : '+'}{currency}{Math.abs(transaction.amount).toFixed(2)}
        </div>
        {netAmount !== null && (
          <div className="text-[10px] font-normal" style={{ color: 'var(--tx-secondary)', letterSpacing: 0 }}>
            net {netAmount < 0 ? '−' : '+'}{currency}{Math.abs(netAmount).toFixed(2)}
          </div>
        )}
      </td>
      <td className="px-3 py-2.5 text-xs" style={{ color: 'var(--tx-secondary)' }}>
        {transaction.splitLegs && transaction.splitLegs.length > 0 ? (
          <button
            onClick={() => setShowSplitLegs((v) => !v)}
            className="flex items-center gap-1 text-xs"
            style={{ color: 'var(--tx-secondary)' }}
          >
            {showSplitLegs ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            Split ×{transaction.splitLegs.length}
          </button>
        ) : transaction.category}
      </td>
      <td className="px-3 py-2.5 text-xs" style={{ color: 'var(--tx-secondary)' }}>
        {transaction.account.name}
      </td>
      <td className="px-3 py-2.5">
        <StatusBadge status={transaction.status} />
      </td>
      <td className="px-3 py-2.5 text-xs max-w-[160px] truncate" style={{ color: 'var(--tx-faint)' }}>
        {transaction.reimbursableFor ? (
          <span>
            <span style={{ color: 'var(--tx-secondary)' }}>{transaction.reimbursableFor}</span>
            {transaction.notes ? <span> · {transaction.notes}</span> : null}
          </span>
        ) : (transaction.notes ?? '—')}
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-3 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
          <button
            onClick={() => setEditing(true)}
            className="text-xs transition-colors duration-150 hover:text-accent"
            style={{ color: 'var(--tx-tertiary)' }}
            aria-label="Edit"
          >
            Edit
          </button>
          {transaction.linkedTransferId ? (
            <button
              onClick={handleUnlink}
              disabled={unlinking}
              className="text-xs transition-colors duration-150 hover:text-error disabled:opacity-40"
              style={{ color: 'var(--tx-tertiary)' }}
              aria-label="Unlink transfer"
              title="Unlink transfer"
            >
              <Unlink size={13} />
            </button>
          ) : (
            <button
              onClick={() => setShowLinkModal(true)}
              className="text-xs transition-colors duration-150 hover:text-accent"
              style={{ color: 'var(--tx-tertiary)' }}
              aria-label="Link transfer"
              title="Link as transfer"
            >
              <Link2 size={13} />
            </button>
          )}
          {/* Reimbursement actions: only show if flagged as reimbursable */}
          {transaction.reimbursableFor && (
            transaction.reimbursementTxId ? (
              <button
                onClick={handleUnlinkReimbursement}
                disabled={unlinkingReimburse}
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
                aria-label="Link reimbursement"
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
              aria-label="Split transaction"
              title="Split transaction"
            >
              <Scissors size={13} />
            </button>
          )}
          <button
            onClick={handleDelete}
            className="text-xs transition-colors duration-150 hover:text-error"
            style={{ color: 'var(--tx-tertiary)' }}
            aria-label="Delete"
          >
            <X size={14} />
          </button>
        </div>
      </td>
    </tr>
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
    {showSplitLegs && transaction.splitLegs && transaction.splitLegs.map((leg) => (
      <tr key={leg.id} style={{ borderTop: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-surface-200)' }}>
        <td className="w-8" />
        <td colSpan={2} className="px-3 py-2 pl-8 text-xs" style={{ color: 'var(--tx-faint)', borderLeft: '2px solid var(--border-warm)' }}>
          {leg.description}
        </td>
        <td className="px-3 py-2 text-xs font-mono whitespace-nowrap" style={{ color: amtColor(leg.amount) }}>
          {leg.amount < 0 ? '−' : '+'}{currency}{Math.abs(leg.amount).toFixed(2)}
        </td>
        <td className="px-3 py-2 text-xs" style={{ color: 'var(--tx-faint)' }}>
          {leg.category}
        </td>
        <td colSpan={4} />
      </tr>
    ))}
    {suggestionBanner}
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
