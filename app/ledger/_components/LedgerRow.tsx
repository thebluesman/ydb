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
    transactionType: transaction.transactionType,
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
      const rawDesc = transaction.originalDescription ?? draft.description
      fetch(`/api/vendor-rules/check?description=${encodeURIComponent(rawDesc)}&amount=${draft.amount}`)
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
      transactionType: transaction.transactionType,
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

  const isTransfer = transaction.transactionType === 'transfer'
  const amtColor = (amt: number) =>
    isTransfer ? '#F59E0B' : amt < 0 ? 'var(--tx-error)' : amt > 0 ? 'var(--tx-success)' : 'var(--tx-faint)'

  const currency =
    accounts.find((a) => a.id === transaction.accountId)?.currency ?? transaction.account.currency

  const rowBorder: React.CSSProperties = { borderTop: '1px solid var(--border-warm)' }

  const netAmount = transaction.reimbursementTx
    ? transaction.amount + transaction.reimbursementTx.amount
    : null

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
                  <input
                    type="date" value={draft.date}
                    onChange={(e) => set('date', e.target.value)}
                    className={fieldInputCls}
                    style={inputStyle}
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
                    type="number" step="0.01" value={draft.amount}
                    onChange={(e) => set('amount', parseFloat(e.target.value) || 0)}
                    className={`${fieldInputCls} font-mono`}
                    style={{ ...inputStyle, color: amtColor(draft.amount) }}
                  />
                </div>
                <div>
                  <label className={labelCls} style={{ color: 'var(--tx-tertiary)' }}>Type</label>
                  <div className="flex rounded-[6px] overflow-hidden" style={{ border: '1px solid var(--border-warm)' }}>
                    {(['debit', 'credit', 'transfer'] as const).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => set('transactionType', t)}
                        className="px-3 py-1.5 text-xs capitalize"
                        style={{
                          backgroundColor: draft.transactionType === t
                            ? t === 'debit' ? 'var(--bg-stat-expense)' : t === 'credit' ? 'var(--bg-stat-income)' : 'rgba(245,158,11,0.15)'
                            : 'var(--bg-input)',
                          color: draft.transactionType === t
                            ? t === 'debit' ? 'var(--tx-stat-expense)' : t === 'credit' ? 'var(--tx-stat-income)' : '#F59E0B'
                            : 'var(--tx-secondary)',
                          borderRight: t !== 'transfer' ? '1px solid var(--border-warm)' : undefined,
                        }}
                      >
                        {t.charAt(0).toUpperCase() + t.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Row 2: Category · Account · Status · Notes */}
              <div className="flex flex-wrap gap-3 items-end">
                <div style={{ minWidth: '150px' }}>
                  <label className={labelCls} style={{ color: 'var(--tx-tertiary)' }}>Category</label>
                  <select
                    value={draft.category}
                    onChange={(e) => set('category', e.target.value)}
                    className={fieldInputCls}
                    style={inputStyle}
                  >
                    {categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
                    {!categories.find((c) => c.name === draft.category) && (
                      <option value={draft.category}>{draft.category}</option>
                    )}
                  </select>
                </div>
                <div style={{ minWidth: '150px' }}>
                  <label className={labelCls} style={{ color: 'var(--tx-tertiary)' }}>Account</label>
                  <select
                    value={draft.accountId}
                    onChange={(e) => set('accountId', parseInt(e.target.value))}
                    className={fieldInputCls}
                    style={inputStyle}
                  >
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
                <div style={{ minWidth: '130px' }}>
                  <label className={labelCls} style={{ color: 'var(--tx-tertiary)' }}>Status</label>
                  <select
                    value={draft.status}
                    onChange={(e) => set('status', e.target.value)}
                    className={fieldInputCls}
                    style={inputStyle}
                  >
                    <option value="review">Review</option>
                    <option value="committed">Committed</option>
                    <option value="reconciled">Reconciled</option>
                  </select>
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
                <button
                  onClick={handleSave} disabled={saving}
                  className="px-4 py-1.5 text-sm rounded-[6px] font-medium disabled:opacity-40"
                  style={{ backgroundColor: 'var(--bg-btn)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}
                >
                  {saving ? '…' : 'Save'}
                </button>
                <button
                  onClick={handleCancel}
                  className="px-3 py-1.5 text-sm rounded-[6px] transition-colors duration-150"
                  style={{ color: 'var(--tx-secondary)', border: '1px solid var(--border-warm)' }}
                >
                  Cancel
                </button>
                {error && <span className="text-xs" style={{ color: 'var(--tx-error)' }}>{error}</span>}
              </div>

            </div>
          </td>
        </tr>
        {ruleSuggestion && (
          <tr>
            <td colSpan={8} className="px-3 py-2" style={{ backgroundColor: 'var(--bg-badge-review)', borderTop: '1px solid var(--border-warm)' }}>
              <div className="flex items-center gap-2 flex-wrap text-xs">
                <span style={{ color: 'var(--tx-badge-review)' }}>No vendor rule matches this description. Create one?</span>
                <input type="text" value={rulePattern} onChange={(e) => setRulePattern(e.target.value)} placeholder="Pattern" className="px-2 py-0.5 rounded-[4px] text-xs outline-none w-48" style={inputStyle} />
                <input type="text" value={ruleVendor} onChange={(e) => setRuleVendor(e.target.value)} placeholder="Vendor name" className="px-2 py-0.5 rounded-[4px] text-xs outline-none w-32" style={inputStyle} />
                <select value={ruleMatchType} onChange={(e) => setRuleMatchType(e.target.value)} className="px-1.5 py-0.5 rounded-[4px] text-xs outline-none" style={inputStyle} title="Match type">
                  <option value="contains">contains</option>
                  <option value="starts-with">starts-with</option>
                  <option value="ends-with">ends-with</option>
                  <option value="exact">exact</option>
                  <option value="regex">regex</option>
                </select>
                <button onClick={handleCreateRule} disabled={ruleSaving} className="px-2 py-0.5 rounded-[4px] text-xs disabled:opacity-40" style={{ backgroundColor: 'var(--bg-btn)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}>
                  {ruleSaving ? '…' : 'Add Rule'}
                </button>
                <button onClick={() => setRuleSuggestion(null)} style={{ color: 'var(--tx-tertiary)' }}><X size={12} /></button>
              </div>
            </td>
          </tr>
        )}
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
  const suggestionBanner = ruleSuggestion ? (
    <tr>
      <td colSpan={8} className="px-3 py-2" style={{ backgroundColor: 'var(--bg-badge-review)', borderTop: '1px solid var(--border-warm)' }}>
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span style={{ color: 'var(--tx-badge-review)' }}>No vendor rule matches this description. Create one?</span>
          <input type="text" value={rulePattern} onChange={(e) => setRulePattern(e.target.value)} placeholder="Pattern" className="px-2 py-0.5 rounded-[4px] text-xs outline-none w-48" style={inputStyle} />
          <input type="text" value={ruleVendor} onChange={(e) => setRuleVendor(e.target.value)} placeholder="Vendor name" className="px-2 py-0.5 rounded-[4px] text-xs outline-none w-32" style={inputStyle} />
          <select value={ruleMatchType} onChange={(e) => setRuleMatchType(e.target.value)} className="px-1.5 py-0.5 rounded-[4px] text-xs outline-none" style={inputStyle} title="Match type">
            <option value="contains">contains</option>
            <option value="starts-with">starts-with</option>
            <option value="ends-with">ends-with</option>
            <option value="exact">exact</option>
            <option value="regex">regex</option>
          </select>
          <button onClick={handleCreateRule} disabled={ruleSaving} className="px-2 py-0.5 rounded-[4px] text-xs disabled:opacity-40" style={{ backgroundColor: 'var(--bg-btn)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}>
            {ruleSaving ? '…' : 'Add Rule'}
          </button>
          <button onClick={() => setRuleSuggestion(null)} style={{ color: 'var(--tx-tertiary)' }}><X size={12} /></button>
        </div>
      </td>
    </tr>
  ) : null

  return (
    <>
      <tr
        className="group transition-colors duration-100"
        style={{ ...rowBorder, cursor: 'default' }}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-row-hover)')}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
      >
        {/* 1 · Checkbox */}
        <td className="px-3 py-3 w-10">
          <input type="checkbox" checked={!!selected} onChange={onToggleSelect} className="cursor-pointer" />
        </td>

        {/* 2 · Date */}
        <td className="px-3 py-3 whitespace-nowrap text-sm" style={{ color: 'var(--tx-secondary)' }}>
          {formatDate(transaction.date)}
        </td>

        {/* 3 · Description + original + notes */}
        <td className="px-3 py-3 max-w-xs">
          <div className="flex items-start gap-1.5 min-w-0">
            <div className="min-w-0 flex-1">
              <div className="text-sm truncate" style={{ color: 'var(--tx-primary)' }}>
                {transaction.description}
              </div>
              {transaction.originalDescription && transaction.originalDescription !== transaction.description && (
                <div
                  className="text-[10px] truncate mt-0.5"
                  style={{ color: 'var(--tx-faint)' }}
                  title={transaction.originalDescription}
                >
                  {transaction.originalDescription}
                </div>
              )}
              {transaction.notes && (
                <div className="text-[11px] truncate mt-0.5 italic" style={{ color: 'var(--tx-faint)' }}>
                  {transaction.notes}
                </div>
              )}
            </div>
            {transaction.linkedTransferId && (
              <span title="Linked transfer" className="mt-0.5">
                <Link2 size={11} style={{ color: 'var(--tx-faint)', flexShrink: 0 }} />
              </span>
            )}
            {transaction.reimbursableFor && !transaction.reimbursementTxId && (
              <span title={`Pending reimbursement from ${transaction.reimbursableFor}`} className="mt-0.5">
                <RotateCcw size={11} style={{ color: 'var(--tx-faint)', flexShrink: 0 }} />
              </span>
            )}
            {transaction.reimbursementTx && (
              <span title={`Reimbursed: ${transaction.reimbursementTx.description}`} className="mt-0.5">
                <CheckCircle2 size={11} style={{ color: 'var(--tx-success)', flexShrink: 0 }} />
              </span>
            )}
            {transaction.reimbursedExpense && (
              <span title={`Reimburses: ${transaction.reimbursedExpense.description}`} className="mt-0.5">
                <RotateCcw size={11} style={{ color: 'var(--tx-success)', flexShrink: 0 }} />
              </span>
            )}
          </div>
        </td>

        {/* 4 · Amount + type label */}
        <td className="px-3 py-3 font-mono whitespace-nowrap" style={{ letterSpacing: '-0.275px' }}>
          <div className="text-sm" style={{ color: amtColor(transaction.amount) }}>
            {transaction.amount < 0 ? '−' : '+'}{currency}{Math.abs(transaction.amount).toFixed(2)}
          </div>
          {netAmount !== null && (
            <div className="text-[10px] font-normal mt-0.5" style={{ color: 'var(--tx-secondary)', letterSpacing: 0 }}>
              net {netAmount < 0 ? '−' : '+'}{currency}{Math.abs(netAmount).toFixed(2)}
            </div>
          )}
          <div
            className="text-[10px] mt-0.5 capitalize font-sans"
            style={{ color: amtColor(transaction.amount), opacity: 0.7 }}
          >
            {transaction.transactionType}
          </div>
        </td>

        {/* 5 · Category (or split toggle) */}
        <td className="px-3 py-3 text-sm" style={{ color: 'var(--tx-secondary)' }}>
          {transaction.splitLegs && transaction.splitLegs.length > 0 ? (
            <button
              onClick={() => setShowSplitLegs((v) => !v)}
              className="flex items-center gap-1 text-sm"
              style={{ color: 'var(--tx-secondary)' }}
            >
              {showSplitLegs ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              Split ×{transaction.splitLegs.length}
            </button>
          ) : (
            transaction.category || <span style={{ color: 'var(--tx-faint)' }}>—</span>
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
                onClick={handleUnlink} disabled={unlinking}
                className="text-xs transition-colors duration-150 hover:text-error disabled:opacity-40"
                style={{ color: 'var(--tx-tertiary)' }}
                title="Unlink transfer"
              >
                <Unlink size={13} />
              </button>
            ) : (
              <button
                onClick={() => setShowLinkModal(true)}
                className="text-xs transition-colors duration-150 hover:text-accent"
                style={{ color: 'var(--tx-tertiary)' }}
                title="Link as transfer"
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
                >
                  <Unlink size={13} />
                </button>
              ) : (
                <button
                  onClick={() => setShowReimburseModal(true)}
                  className="text-xs transition-colors duration-150 hover:text-accent"
                  style={{ color: 'var(--tx-tertiary)' }}
                  title="Link reimbursement transaction"
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
          <td className="px-3 py-2.5 text-sm font-mono whitespace-nowrap" style={{ color: amtColor(leg.amount), letterSpacing: '-0.275px' }}>
            {leg.amount < 0 ? '−' : '+'}{currency}{Math.abs(leg.amount).toFixed(2)}
          </td>
          <td className="px-3 py-2.5 text-sm" style={{ color: 'var(--tx-faint)' }}>
            {leg.category}
          </td>
          <td colSpan={3} />
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
