'use client'

import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, ChevronDown, Plus } from 'lucide-react'
import * as Select from '@radix-ui/react-select'

export type DraftTransaction = {
  _id: string; date: string; description: string; amount: number
  category: string; accountId: number; notes: string; rawSource: string
}

type Account = { id: number; name: string; currency: string }
type Category = { id: number; name: string; color: string }

const inputCls = 'w-full px-2 py-1 text-xs rounded-[6px] outline-none transition-colors duration-150'

const amountColor = (amt: number, category?: string) =>
  category === 'Transfer' ? '#F59E0B' : amt < 0 ? 'var(--tx-error)' : amt > 0 ? 'var(--tx-success)' : 'var(--tx-tertiary)'

const inputStyle = { border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }
const selectContent: React.CSSProperties = {
  backgroundColor: 'var(--bg-card)',
  border: '1px solid var(--border-warm)',
  boxShadow: 'var(--shadow-card)',
  borderRadius: '8px',
  zIndex: 9999,
}

// ── Add Category Modal ────────────────────────────────────────────────────────

function AddCategoryModal({
  onAdd,
  onClose,
}: {
  onAdd: (cat: Category) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleSubmit = async () => {
    const trimmed = name.trim()
    if (!trimmed) { setError('Name required'); return }
    setSaving(true); setError('')
    try {
      const res = await fetch('/api/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error ?? 'Failed to create')
      }
      const cat: Category = await res.json()
      onAdd(cat)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
      setSaving(false)
    }
  }

  const modal = (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 10000, backgroundColor: 'rgba(0,0,0,0.5)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="w-full max-w-sm rounded-[12px] p-6 space-y-4"
        style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-warm)', boxShadow: 'var(--shadow-card)' }}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold" style={{ color: 'var(--tx-primary)' }}>New category</h3>
          <button onClick={onClose} style={{ color: 'var(--tx-tertiary)' }}><X size={15} /></button>
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--tx-tertiary)' }}>Name</label>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => { setName(e.target.value); setError('') }}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            placeholder="e.g. Groceries"
            className="w-full px-3 py-2 text-sm rounded-[8px] outline-none"
            style={inputStyle}
          />
          {error && <p className="mt-1 text-xs" style={{ color: 'var(--tx-error)' }}>{error}</p>}
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded-[6px]"
            style={{ color: 'var(--tx-secondary)', border: '1px solid var(--border-warm)' }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="px-4 py-1.5 text-sm rounded-[6px] font-medium disabled:opacity-40"
            style={{ backgroundColor: 'var(--bg-btn)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}
          >
            {saving ? '…' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}

// ── Category Select ───────────────────────────────────────────────────────────

const ADD_NEW_SENTINEL = '__add_new__'

function CategorySelect({
  value,
  categories,
  onChange,
  onAddNew,
}: {
  value: string
  categories: Category[]
  onChange: (v: string) => void
  onAddNew: () => void
}) {
  const handleChange = (v: string) => {
    if (v === ADD_NEW_SENTINEL) { onAddNew(); return }
    onChange(v)
  }

  // If current value isn't in categories list, include it as an option
  const hasValue = categories.some((c) => c.name === value)

  return (
    <Select.Root value={value} onValueChange={handleChange}>
      <Select.Trigger
        className="flex items-center gap-1.5 w-full px-2 py-1 text-xs rounded-[6px] outline-none"
        style={inputStyle}
      >
        <Select.Value />
        <Select.Icon className="ml-auto shrink-0" style={{ color: 'var(--tx-tertiary)' }}>
          <ChevronDown size={11} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content position="popper" sideOffset={4} style={{ ...selectContent, minWidth: 'var(--radix-select-trigger-width)' }}>
          <Select.Viewport className="p-1">
            {!hasValue && (
              <Select.Item
                value={value}
                className="px-3 py-1.5 text-xs rounded-[6px] cursor-pointer outline-none select-none"
                style={{ color: 'var(--tx-primary)' }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-card-alt)')}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
              >
                <Select.ItemText>{value}</Select.ItemText>
              </Select.Item>
            )}
            {categories.map((c) => (
              <Select.Item
                key={c.id} value={c.name}
                className="px-3 py-1.5 text-xs rounded-[6px] cursor-pointer outline-none select-none"
                style={{ color: 'var(--tx-primary)' }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-card-alt)')}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
              >
                <Select.ItemText>{c.name}</Select.ItemText>
              </Select.Item>
            ))}
            <Select.Separator style={{ height: '1px', backgroundColor: 'var(--border-warm)', margin: '4px 0' }} />
            <Select.Item
              value={ADD_NEW_SENTINEL}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-[6px] cursor-pointer outline-none select-none"
              style={{ color: 'var(--tx-secondary)' }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-card-alt)')}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
            >
              <Plus size={11} />
              <Select.ItemText>Add new category</Select.ItemText>
            </Select.Item>
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  )
}

// ── Add Account Modal ─────────────────────────────────────────────────────────

const ACCOUNT_TYPES = [
  { value: 'current',      label: 'Current' },
  { value: 'savings',      label: 'Savings' },
  { value: 'cash',         label: 'Cash' },
  { value: 'credit',       label: 'Credit card' },
  { value: 'personal_loan',label: 'Personal loan' },
  { value: 'auto_loan',    label: 'Auto loan' },
]

const CURRENCIES = [
  'AED','AUD','BHD','CAD','CHF','CNY','EUR','GBP',
  'HKD','INR','JPY','KWD','OMR','PKR','QAR','SAR','SGD','USD',
]

function AddAccountModal({
  onAdd,
  onClose,
}: {
  onAdd: (acc: Account) => void
  onClose: () => void
}) {
  const [name, setName]             = useState('')
  const [accountType, setType]      = useState('current')
  const [currency, setCurrency]     = useState('GBP')
  const [saving, setSaving]         = useState(false)
  const [error, setError]           = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleSubmit = async () => {
    const trimmed = name.trim()
    if (!trimmed) { setError('Name required'); return }
    setSaving(true); setError('')
    try {
      const res = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ name: trimmed, accountType, currency }]),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error ?? 'Failed to create')
      }
      const [acc]: Account[] = await res.json()
      onAdd(acc)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
      setSaving(false)
    }
  }

  const fieldLabel = 'block text-[10px] uppercase tracking-wide mb-1'
  const nativeSelect = 'w-full px-3 py-2 text-sm rounded-[8px] outline-none'

  const modal = (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 10000, backgroundColor: 'rgba(0,0,0,0.5)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="w-full max-w-sm rounded-[12px] p-6 space-y-4"
        style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-warm)', boxShadow: 'var(--shadow-card)' }}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold" style={{ color: 'var(--tx-primary)' }}>New account</h3>
          <button onClick={onClose} style={{ color: 'var(--tx-tertiary)' }}><X size={15} /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className={fieldLabel} style={{ color: 'var(--tx-tertiary)' }}>Name</label>
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); setError('') }}
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
              placeholder="e.g. Cash Wallet"
              className="w-full px-3 py-2 text-sm rounded-[8px] outline-none"
              style={inputStyle}
            />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className={fieldLabel} style={{ color: 'var(--tx-tertiary)' }}>Type</label>
              <select
                value={accountType}
                onChange={(e) => setType(e.target.value)}
                className={nativeSelect}
                style={inputStyle}
              >
                {ACCOUNT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label className={fieldLabel} style={{ color: 'var(--tx-tertiary)' }}>Currency</label>
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className={nativeSelect}
                style={inputStyle}
              >
                {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
          {error && <p className="text-xs" style={{ color: 'var(--tx-error)' }}>{error}</p>}
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded-[6px]"
            style={{ color: 'var(--tx-secondary)', border: '1px solid var(--border-warm)' }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="px-4 py-1.5 text-sm rounded-[6px] font-medium disabled:opacity-40"
            style={{ backgroundColor: 'var(--bg-btn)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}
          >
            {saving ? '…' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}

// ── Account Select ────────────────────────────────────────────────────────────

const ADD_NEW_ACCOUNT_SENTINEL = '__add_new_account__'

function AccountSelect({
  value,
  accounts,
  onChange,
  onAddNew,
}: {
  value: number
  accounts: Account[]
  onChange: (id: number) => void
  onAddNew: () => void
}) {
  const handleChange = (v: string) => {
    if (v === ADD_NEW_ACCOUNT_SENTINEL) { onAddNew(); return }
    onChange(parseInt(v))
  }

  return (
    <Select.Root value={String(value)} onValueChange={handleChange}>
      <Select.Trigger
        className="flex items-center gap-1.5 w-full px-2 py-1 text-xs rounded-[6px] outline-none"
        style={inputStyle}
      >
        <Select.Value />
        <Select.Icon className="ml-auto shrink-0" style={{ color: 'var(--tx-tertiary)' }}>
          <ChevronDown size={11} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content position="popper" sideOffset={4} style={{ ...selectContent, minWidth: 'var(--radix-select-trigger-width)' }}>
          <Select.Viewport className="p-1">
            {accounts.map((a) => (
              <Select.Item
                key={a.id} value={String(a.id)}
                className="px-3 py-1.5 text-xs rounded-[6px] cursor-pointer outline-none select-none"
                style={{ color: 'var(--tx-primary)' }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-card-alt)')}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
              >
                <Select.ItemText>{a.name}</Select.ItemText>
              </Select.Item>
            ))}
            <Select.Separator style={{ height: '1px', backgroundColor: 'var(--border-warm)', margin: '4px 0' }} />
            <Select.Item
              value={ADD_NEW_ACCOUNT_SENTINEL}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-[6px] cursor-pointer outline-none select-none"
              style={{ color: 'var(--tx-secondary)' }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-card-alt)')}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
            >
              <Plus size={11} />
              <Select.ItemText>Add new account</Select.ItemText>
            </Select.Item>
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  )
}

// ── ReviewTable ───────────────────────────────────────────────────────────────

export function ReviewTable({ drafts, accounts: initialAccounts, categories: initialCategories, onChange, onCommit, onDiscard }: {
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

  // Local category list — starts from prop, can grow via "Add new"
  const [categories, setCategories] = useState<Category[]>(initialCategories)
  // Local account list — starts from prop, can grow via "Add new"
  const [accounts, setAccounts] = useState<Account[]>(initialAccounts)
  // Which row's _id triggered the Add Category modal (null = closed)
  const [addCategoryForRow, setAddCategoryForRow] = useState<string | null>(null)
  // Which row's _id triggered the Add Account modal (null = closed)
  const [addAccountForRow, setAddAccountForRow] = useState<string | null>(null)

  useEffect(() => {
    if (drafts.length === 0) return
    const candidates = drafts.map((d) => ({
      _id: d._id, date: d.date, amount: d.amount,
      description: d.description, accountId: d.accountId,
    }))
    fetch('/api/transactions/check-duplicates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidates }),
    })
      .then((r) => r.json())
      .then((data) => setDuplicateIds(new Set(data.duplicateIds ?? [])))
      .catch(() => { /* silent */ })
  }, [drafts.length])

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

  const handleCategoryAdded = (cat: Category) => {
    setCategories((prev) => [...prev, cat].sort((a, b) => a.name.localeCompare(b.name)))
    if (addCategoryForRow) update(addCategoryForRow, 'category', cat.name)
    setAddCategoryForRow(null)
  }

  const handleAccountAdded = (acc: Account) => {
    setAccounts((prev) => [...prev, acc])
    if (addAccountForRow) update(addAccountForRow, 'accountId', acc.id)
    setAddAccountForRow(null)
  }

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
                      style={{ ...inputStyle, color: amountColor(d.amount, d.category) }} />
                  </td>
                  <td className="px-2 py-1.5 min-w-[130px]">
                    <CategorySelect
                      value={d.category}
                      categories={categories}
                      onChange={(v) => update(d._id, 'category', v)}
                      onAddNew={() => setAddCategoryForRow(d._id)}
                    />
                  </td>
                  <td className="px-2 py-1.5 min-w-[140px]">
                    <AccountSelect
                      value={d.accountId}
                      accounts={accounts}
                      onChange={(id) => update(d._id, 'accountId', id)}
                      onAddNew={() => setAddAccountForRow(d._id)}
                    />
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

      {addCategoryForRow !== null && (
        <AddCategoryModal
          onAdd={handleCategoryAdded}
          onClose={() => setAddCategoryForRow(null)}
        />
      )}
      {addAccountForRow !== null && (
        <AddAccountModal
          onAdd={handleAccountAdded}
          onClose={() => setAddAccountForRow(null)}
        />
      )}
    </div>
  )
}
