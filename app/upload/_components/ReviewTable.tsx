'use client'

import { useState, useEffect } from 'react'
import { X } from 'lucide-react'

export type DraftTransaction = {
  _id: string; date: string; description: string; amount: number
  category: string; accountId: number; notes: string; rawSource: string
}

type Account = { id: number; name: string; currency: string }
type Category = { id: number; name: string; color: string }

const inputCls = 'w-full px-2 py-1 text-xs rounded-[6px] outline-none transition-colors duration-150'

const amountColor = (amt: number) =>
  amt < 0 ? 'var(--tx-error)' : amt > 0 ? 'var(--tx-success)' : 'var(--tx-tertiary)'

export function ReviewTable({ drafts, accounts, categories, onChange, onCommit, onDiscard }: {
  drafts: DraftTransaction[]
  accounts: Account[]
  categories: Category[]
  onChange: (drafts: DraftTransaction[]) => void
  onCommit: () => Promise<void>
  onDiscard: () => void
}) {
  const [committing, setCommitting] = useState(false)
  const [error, setError] = useState('')
  const [duplicateIds, setDuplicateIds] = useState<Set<string>>(new Set())
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set())

  // Check for duplicates whenever drafts change
  useEffect(() => {
    if (drafts.length === 0) return
    const candidates = drafts.map((d) => ({
      _id: d._id,
      date: d.date,
      amount: d.amount,
      description: d.description,
      accountId: d.accountId,
    }))
    fetch('/api/transactions/check-duplicates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidates }),
    })
      .then((r) => r.json())
      .then((data) => setDuplicateIds(new Set(data.duplicateIds ?? [])))
      .catch(() => { /* silent — duplicate detection is best-effort */ })
  }, [drafts.length]) // only re-check when row count changes, not on every edit

  const update = (id: string, field: keyof DraftTransaction, value: string | number) =>
    onChange(drafts.map((d) => (d._id === id ? { ...d, [field]: value } : d)))

  const remove = (id: string) => {
    onChange(drafts.filter((d) => d._id !== id))
    setDuplicateIds((prev) => { const n = new Set(prev); n.delete(id); return n })
    setDismissedIds((prev) => { const n = new Set(prev); n.delete(id); return n })
  }

  const addRow = () => onChange([...drafts, {
    _id: crypto.randomUUID(),
    date: new Date().toISOString().split('T')[0],
    description: '', amount: 0,
    category: categories[0]?.name ?? 'Other',
    accountId: accounts[0]?.id ?? 0,
    notes: '', rawSource: '',
  }])

  const handleCommit = async () => {
    setCommitting(true); setError('')
    try { await onCommit() }
    catch (e) { setError(String(e)); setCommitting(false) }
  }

  const dismissDuplicate = (id: string) =>
    setDismissedIds((prev) => new Set([...prev, id]))

  const inputStyle = { border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }

  const unflaggedDuplicates = drafts.filter(
    (d) => duplicateIds.has(d._id) && !dismissedIds.has(d._id)
  ).length

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[22px] font-semibold" style={{ letterSpacing: '-0.11px', color: 'var(--tx-primary)' }}>
          Review {drafts.length} transaction{drafts.length !== 1 ? 's' : ''}
        </h2>
        <p className="text-xs" style={{ color: 'var(--tx-secondary)' }}>Edit any field before committing.</p>
      </div>

      {unflaggedDuplicates > 0 && (
        <p className="text-xs px-3 py-2 rounded-[8px]" style={{ backgroundColor: 'var(--bg-badge-review)', color: 'var(--tx-badge-review)', border: '1px solid var(--border-warm)' }}>
          {unflaggedDuplicates} possible duplicate{unflaggedDuplicates !== 1 ? 's' : ''} detected. Review the highlighted rows before committing.
        </p>
      )}

      <div className="overflow-x-auto rounded-[8px]" style={{ border: '1px solid var(--border-warm)' }}>
        <table className="w-full text-xs">
          <thead style={{ backgroundColor: 'var(--bg-table-head)' }}>
            <tr>
              {['Date', 'Description', 'Amount', 'Category', 'Account', 'Notes', ''].map((h) => (
                <th key={h} className="px-3 py-2 text-left font-medium whitespace-nowrap" style={{ color: 'var(--tx-secondary)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody style={{ backgroundColor: 'var(--bg-card)' }}>
            {drafts.map((d) => {
              const isDuplicate = duplicateIds.has(d._id) && !dismissedIds.has(d._id)
              return (
                <tr
                  key={d._id}
                  style={{
                    borderTop: '1px solid var(--border-warm)',
                    backgroundColor: isDuplicate ? 'var(--bg-badge-review)' : undefined,
                  }}
                >
                  <td className="px-2 py-1.5 min-w-[120px]">
                    <input type="date" value={d.date} onChange={(e) => update(d._id, 'date', e.target.value)} className={inputCls} style={inputStyle} />
                  </td>
                  <td className="px-2 py-1.5 min-w-[200px]">
                    <div className="flex items-center gap-1.5">
                      <input type="text" value={d.description} onChange={(e) => update(d._id, 'description', e.target.value)} className={inputCls} style={inputStyle} />
                      {isDuplicate && (
                        <span
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] whitespace-nowrap cursor-pointer flex-none"
                          style={{ backgroundColor: 'var(--bg-badge-review)', color: 'var(--tx-badge-review)', border: '1px solid var(--border-warm)' }}
                          title="Dismiss duplicate warning"
                          onClick={() => dismissDuplicate(d._id)}
                        >
                          Possible duplicate ×
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-1.5 min-w-[100px]">
                    <input type="number" step="0.01" value={d.amount}
                      onChange={(e) => update(d._id, 'amount', parseFloat(e.target.value) || 0)}
                      className={`${inputCls} font-mono`}
                      style={{ ...inputStyle, color: amountColor(d.amount) }} />
                  </td>
                  <td className="px-2 py-1.5 min-w-[130px]">
                    <select value={d.category} onChange={(e) => update(d._id, 'category', e.target.value)} className={inputCls} style={inputStyle}>
                      {categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
                      {!categories.find((c) => c.name === d.category) && <option value={d.category}>{d.category}</option>}
                    </select>
                  </td>
                  <td className="px-2 py-1.5 min-w-[140px]">
                    <select value={d.accountId} onChange={(e) => update(d._id, 'accountId', parseInt(e.target.value))} className={inputCls} style={inputStyle}>
                      {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-1.5 min-w-[160px]">
                    <input type="text" value={d.notes} placeholder="Optional" onChange={(e) => update(d._id, 'notes', e.target.value)} className={inputCls} style={inputStyle} />
                  </td>
                  <td className="px-2 py-1.5">
                    <button onClick={() => remove(d._id)} className="transition-colors duration-150 hover:text-error" style={{ color: 'var(--tx-tertiary)' }} aria-label="Remove row"><X size={14} /></button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {drafts.length === 0 && (
        <p className="text-sm text-center py-4" style={{ color: 'var(--tx-secondary)' }}>
          All rows removed. Add one or discard.
        </p>
      )}

      {error && (
        <p className="text-sm px-4 py-2 rounded-[8px]" style={{ backgroundColor: 'var(--bg-notify-error)', color: 'var(--tx-notify-error)' }}>
          {error}
        </p>
      )}

      <div className="flex items-center gap-3 pt-2">
        <button onClick={addRow} className="px-[12px] py-[7px] text-sm rounded-[8px] transition-colors duration-150 hover:text-error"
          style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-card)', color: 'var(--tx-primary)' }}>
          + Add row
        </button>
        <button onClick={onDiscard} className="px-[12px] py-[7px] text-sm rounded-[8px] transition-colors duration-150 hover:text-error"
          style={{ color: 'var(--tx-secondary)' }}>
          Discard
        </button>
        <button onClick={handleCommit} disabled={committing || drafts.length === 0}
          className="ml-auto px-[14px] py-[10px] rounded-[8px] text-sm font-semibold transition-colors duration-150 hover:text-error disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ backgroundColor: 'var(--bg-btn)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}>
          {committing ? 'Saving…' : `Commit ${drafts.length} transaction${drafts.length !== 1 ? 's' : ''}`}
        </button>
      </div>
    </div>
  )
}
