'use client'

import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, ChevronDown, Plus, Check } from 'lucide-react'
import * as Select from '@radix-ui/react-select'
import { DatePicker } from '@/app/_components/DatePicker'

export type DraftTransaction = {
  _id: string; date: string; description: string; originalDescription: string; amount: number
  transactionType: string; category: string; accountId: number; notes: string; rawSource: string
  transferCounterpartAccountId?: number | null
}

type Account = { id: number; name: string; currency: string }
type Category = { id: number; name: string; color: string }
type RuleSuggestion = { pattern: string; vendor: string; category: string; matchType: string }

const inputCls = 'w-full px-2 py-1.5 text-sm rounded-[6px] outline-none transition-colors duration-150'

const amountColor = (amt: number, transactionType?: string) =>
  transactionType === 'transfer' ? '#F59E0B' : amt < 0 ? 'var(--tx-error)' : amt > 0 ? 'var(--tx-success)' : 'var(--tx-tertiary)'

const inputStyle = { border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }
const selectContent: React.CSSProperties = {
  backgroundColor: 'var(--bg-card)',
  border: '1px solid var(--border-warm)',
  boxShadow: 'var(--shadow-card)',
  borderRadius: '8px',
  zIndex: 9999,
}

// ── Row Text Input (local state to avoid full-table re-renders on each keystroke) ──

function RowTextInput({ value, onChange, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { value: string; onChange: (v: string) => void }) {
  const [local, setLocal] = useState(value)
  const externalRef = useRef(value)
  // Sync if the value was changed from outside (e.g. reset)
  if (externalRef.current !== value && local !== value) {
    externalRef.current = value
    setLocal(value)
  }
  return (
    <input
      {...props}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={(e) => {
        onChange(local)
        props.onBlur?.(e)
      }}
    />
  )
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
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  const handleChange = (v: string) => {
    if (v === ADD_NEW_SENTINEL) { onAddNew(); return }
    onChange(v)
  }

  const hasValue = categories.some((c) => c.name === value)
  const q = search.toLowerCase()
  const filtered = q ? categories.filter((c) => c.name.toLowerCase().includes(q)) : categories

  return (
    <Select.Root
      value={value}
      onValueChange={handleChange}
      onOpenChange={(open) => { if (!open) setSearch('') }}
    >
      <Select.Trigger
        className="flex items-center gap-1.5 w-full px-2 py-1.5 text-sm rounded-[6px] outline-none"
        style={inputStyle}
      >
        <span className="flex-1 truncate text-left">{value}</span>
        <Select.Icon className="ml-auto shrink-0" style={{ color: 'var(--tx-tertiary)' }}>
          <ChevronDown size={12} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper" sideOffset={4}
          style={{ ...selectContent, minWidth: 'var(--radix-select-trigger-width)' }}
          onAnimationStart={() => searchRef.current?.focus()}
        >
          {/* Search box — stopPropagation prevents Radix typeahead from stealing keystrokes */}
          <div className="px-2 pt-2 pb-1">
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="Search…"
              className="w-full px-2 py-1 text-sm rounded-[4px] outline-none"
              style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }}
            />
          </div>
          <Select.Viewport className="p-1" style={{ maxHeight: 220, overflowY: 'auto' }}>
            {!hasValue && !q && (
              <Select.Item
                value={value}
                className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-[6px] cursor-pointer outline-none select-none hover:bg-[var(--bg-card-alt)]"
                style={{ color: 'var(--tx-primary)' }}
              >
                <Check size={12} style={{ flexShrink: 0, color: 'var(--tx-secondary)' }} />
                <Select.ItemText>{value}</Select.ItemText>
              </Select.Item>
            )}
            {filtered.map((c) => (
              <Select.Item
                key={c.id} value={c.name}
                className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-[6px] cursor-pointer outline-none select-none hover:bg-[var(--bg-card-alt)]"
                style={{ color: 'var(--tx-primary)' }}
              >
                <span style={{ width: 12, flexShrink: 0 }}>
                  {c.name === value && <Check size={12} style={{ color: 'var(--tx-secondary)' }} />}
                </span>
                <Select.ItemText>{c.name}</Select.ItemText>
              </Select.Item>
            ))}
            {filtered.length === 0 && (
              <div className="px-3 py-2 text-sm" style={{ color: 'var(--tx-tertiary)' }}>No matches</div>
            )}
            <Select.Separator style={{ height: '1px', backgroundColor: 'var(--border-warm)', margin: '4px 0' }} />
            <Select.Item
              value={ADD_NEW_SENTINEL}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-[6px] cursor-pointer outline-none select-none hover:bg-[var(--bg-card-alt)]"
              style={{ color: 'var(--tx-secondary)' }}
            >
              <Plus size={12} />
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
        className="flex items-center gap-1.5 w-full px-2 py-1.5 text-sm rounded-[6px] outline-none"
        style={inputStyle}
      >
        <Select.Value />
        <Select.Icon className="ml-auto shrink-0" style={{ color: 'var(--tx-tertiary)' }}>
          <ChevronDown size={12} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content position="popper" sideOffset={4} style={{ ...selectContent, minWidth: 'var(--radix-select-trigger-width)' }}>
          <Select.Viewport className="p-1">
            {accounts.map((a) => (
              <Select.Item
                key={a.id} value={String(a.id)}
                className="px-3 py-1.5 text-sm rounded-[6px] cursor-pointer outline-none select-none"
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
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-[6px] cursor-pointer outline-none select-none"
              style={{ color: 'var(--tx-secondary)' }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-card-alt)')}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
            >
              <Plus size={12} />
              <Select.ItemText>Add new account</Select.ItemText>
            </Select.Item>
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  )
}

// ── Type Select ───────────────────────────────────────────────────────────────

const TYPE_OPTIONS = [
  { value: 'debit',    label: 'Debit',    dot: 'var(--tx-stat-expense)', color: 'var(--tx-stat-expense)' },
  { value: 'credit',   label: 'Credit',   dot: 'var(--tx-stat-income)',  color: 'var(--tx-stat-income)' },
  { value: 'transfer', label: 'Transfer', dot: '#F59E0B',                color: '#F59E0B' },
]

function TypeSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const current = TYPE_OPTIONS.find((o) => o.value === value) ?? TYPE_OPTIONS[0]
  return (
    <Select.Root value={value} onValueChange={onChange}>
      <Select.Trigger
        className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded-[6px] outline-none"
        style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: current.color }}
      >
        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: current.dot }} />
        <Select.Value />
        <Select.Icon className="ml-auto shrink-0" style={{ color: 'var(--tx-tertiary)' }}>
          <ChevronDown size={12} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper" sideOffset={4}
          style={{ ...selectContent, minWidth: 'var(--radix-select-trigger-width)' }}
        >
          <Select.Viewport className="p-1">
            {TYPE_OPTIONS.map((opt) => (
              <Select.Item
                key={opt.value} value={opt.value}
                className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-[6px] cursor-pointer outline-none select-none"
                style={{ color: 'var(--tx-primary)' }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-card-alt)')}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: opt.dot }} />
                <Select.ItemText>{opt.label}</Select.ItemText>
              </Select.Item>
            ))}
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

  const [categories, setCategories] = useState<Category[]>(initialCategories)
  const [accounts, setAccounts] = useState<Account[]>(initialAccounts)
  const [addCategoryForRow, setAddCategoryForRow] = useState<string | null>(null)
  const [addAccountForRow, setAddAccountForRow] = useState<string | null>(null)

  const [ruleSuggestions, setRuleSuggestions] = useState<Map<string, RuleSuggestion>>(new Map())
  const [dismissedRules, setDismissedRules] = useState<Set<string>>(new Set())
  const [savingRuleId, setSavingRuleId] = useState<string | null>(null)

  // Collapsible notes: pre-expand rows that already have notes
  const [expandedNotes, setExpandedNotes] = useState<Set<string>>(
    () => new Set(drafts.filter((d) => d.notes).map((d) => d._id))
  )

  // Transfer direction per row: 'out' = negative (money leaving), 'in' = positive
  const [transferDirections, setTransferDirections] = useState<Map<string, 'in' | 'out'>>(
    () => new Map(drafts.map((d) => [d._id, d.amount >= 0 ? 'in' : 'out'] as [string, 'in' | 'out']))
  )
  const setTransferDirection = (id: string, dir: 'in' | 'out') =>
    setTransferDirections((prev) => new Map(prev).set(id, dir))
  const getTransferDirection = (d: DraftTransaction): 'in' | 'out' =>
    transferDirections.get(d._id) ?? (d.amount >= 0 ? 'in' : 'out')

  const computeSignedAmount = (d: DraftTransaction): number => {
    const abs = Math.abs(d.amount)
    if (d.transactionType === 'debit') return -abs
    if (d.transactionType === 'credit') return abs
    return getTransferDirection(d) === 'in' ? abs : -abs
  }

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

  const update = (id: string, field: keyof DraftTransaction, value: string | number | null) =>
    onChange(drafts.map((d) => (d._id === id ? { ...d, [field]: value } : d)))

  const updateFields = (id: string, fields: Partial<DraftTransaction>) =>
    onChange(drafts.map((d) => (d._id === id ? { ...d, ...fields } : d)))

  const remove = (id: string) => {
    onChange(drafts.filter((d) => d._id !== id))
    setDuplicateIds((prev) => { const n = new Set(prev); n.delete(id); return n })
    setDismissedIds((prev) => { const n = new Set(prev); n.delete(id); return n })
    setExpandedNotes((prev) => { const n = new Set(prev); n.delete(id); return n })
    setTransferDirections((prev) => { const n = new Map(prev); n.delete(id); return n })
  }

  const addRow = () => onChange([...drafts, {
    _id: crypto.randomUUID(),
    date: new Date().toISOString().split('T')[0],
    description: '', originalDescription: '', amount: 0,
    transactionType: 'debit',
    category: categories[0]?.name ?? '',
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

  const handleCategoryChange = (id: string, newCategory: string) => {
    update(id, 'category', newCategory)
    if (dismissedRules.has(id)) return
    const draft = drafts.find((d) => d._id === id)
    const rawText = (draft?.originalDescription || draft?.description || '').trim()
    const displayName = (draft?.description || '').trim()
    if (!rawText) return
    setRuleSuggestions((prev) => new Map(prev).set(id, {
      pattern: rawText,
      vendor: displayName || rawText,
      category: newCategory,
      matchType: 'contains',
    }))
  }

  const updateRuleSuggestion = (id: string, field: keyof RuleSuggestion, value: string) =>
    setRuleSuggestions((prev) => {
      const existing = prev.get(id)
      if (!existing) return prev
      return new Map(prev).set(id, { ...existing, [field]: value })
    })

  const dismissRuleSuggestion = (id: string) => {
    setRuleSuggestions((prev) => { const n = new Map(prev); n.delete(id); return n })
    setDismissedRules((prev) => new Set([...prev, id]))
  }

  const handleSaveRule = async (id: string) => {
    const suggestion = ruleSuggestions.get(id)
    if (!suggestion) return
    const draft = drafts.find((d) => d._id === id)
    setSavingRuleId(id)
    try {
      const res = await fetch('/api/vendor-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pattern: suggestion.pattern,
          vendor: suggestion.vendor,
          category: suggestion.category,
          matchType: suggestion.matchType,
          direction: (draft?.amount ?? 0) < 0 ? 'debit' : (draft?.amount ?? 0) > 0 ? 'credit' : 'either',
        }),
      })
      if (!res.ok) throw new Error(await res.text())
      dismissRuleSuggestion(id)
    } catch { /* silent */ } finally {
      setSavingRuleId(null)
    }
  }

  const handleCategoryAdded = (cat: Category) => {
    setCategories((prev) => [...prev, cat].sort((a, b) => a.name.localeCompare(b.name)))
    if (addCategoryForRow) handleCategoryChange(addCategoryForRow, cat.name)
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

      <div className="rounded-[8px] overflow-hidden" style={{ border: '1px solid var(--border-warm)' }}>
        {drafts.length === 0 ? (
          <p className="text-sm text-center py-8" style={{ color: 'var(--tx-secondary)', backgroundColor: 'var(--bg-card)' }}>
            All rows removed. Add one or discard.
          </p>
        ) : (
          drafts.map((d, idx) => {
            const isDuplicate = duplicateIds.has(d._id) && !dismissedIds.has(d._id)
            const ruleSuggestion = ruleSuggestions.get(d._id) ?? null
            return (
              <div
                key={d._id}
                style={{
                  borderTop: idx > 0 ? '1px solid var(--border-warm)' : undefined,
                  backgroundColor: 'var(--bg-card)',
                }}
              >
                {/* Duplicate warning strip */}
                {isDuplicate && (
                  <div
                    className="flex items-center justify-between px-4 py-1.5"
                    style={{ backgroundColor: 'var(--bg-badge-review)', borderBottom: '1px solid var(--border-warm)' }}
                  >
                    <span className="text-xs" style={{ color: 'var(--tx-badge-review)' }}>
                      Possible duplicate — verify before committing
                    </span>
                    <button
                      onClick={() => dismissDuplicate(d._id)}
                      className="text-xs underline transition-opacity hover:opacity-70"
                      style={{ color: 'var(--tx-badge-review)' }}
                    >
                      Dismiss
                    </button>
                  </div>
                )}

                {/* Card body */}
                <div className="flex gap-4 px-4 py-3 items-start">
                  {/* Left: Date + Type */}
                  <div className="shrink-0 space-y-2" style={{ width: 148 }}>
                    <DatePicker
                      value={d.date}
                      onChange={(v) => update(d._id, 'date', v)}
                      style={{ width: '100%' }}
                    />
                    <TypeSelect
                      value={d.transactionType}
                      onChange={(v) => {
                        const abs = Math.abs(d.amount)
                        let newAmount: number
                        if (v === 'debit') newAmount = -abs
                        else if (v === 'credit') newAmount = abs
                        else {
                          const dir = getTransferDirection(d)
                          newAmount = dir === 'in' ? abs : -abs
                        }
                        updateFields(d._id, {
                          transactionType: v,
                          amount: newAmount,
                          ...(v !== 'transfer' ? { transferCounterpartAccountId: null } : {}),
                        })
                      }}
                    />
                  </div>

                  {/* Middle: Description + originalDescription + Notes */}
                  <div className="flex-1 min-w-0 space-y-2">
                    <RowTextInput
                      type="text"
                      value={d.description}
                      onChange={(v) => update(d._id, 'description', v)}
                      placeholder="Description"
                      className={inputCls}
                      style={inputStyle}
                    />
                    {d.originalDescription && d.originalDescription !== d.description && (
                      <div
                        className="text-[11px] truncate px-0.5"
                        style={{ color: 'var(--tx-faint)' }}
                        title={d.originalDescription}
                      >
                        {d.originalDescription}
                      </div>
                    )}
                    {expandedNotes.has(d._id) ? (
                      <RowTextInput
                        type="text"
                        value={d.notes}
                        onChange={(v) => update(d._id, 'notes', v)}
                        placeholder="Notes (optional)"
                        className={inputCls}
                        style={{ ...inputStyle, fontStyle: 'italic' }}
                        autoFocus={!d.notes}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => setExpandedNotes((prev) => new Set([...prev, d._id]))}
                        className="text-xs py-0.5 text-left transition-opacity duration-100 hover:opacity-80"
                        style={{ color: 'var(--tx-faint)' }}
                      >
                        + Add note
                      </button>
                    )}
                  </div>

                  {/* Right: Amount + Direction (transfer) + Category + Account + Counterpart (transfer) */}
                  <div className="shrink-0 space-y-2" style={{ width: 176 }}>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={Math.abs(d.amount)}
                        onChange={(e) => {
                          const abs = Math.abs(parseFloat(e.target.value) || 0)
                          const signed = computeSignedAmount({ ...d, amount: abs })
                          update(d._id, 'amount', signed)
                        }}
                        className={`${inputCls} font-mono text-right`}
                        style={{ ...inputStyle, color: amountColor(d.amount, d.transactionType) }}
                      />
                    </div>
                    {d.transactionType === 'transfer' && (
                      <Select.Root
                        value={getTransferDirection(d)}
                        onValueChange={(dir) => {
                          setTransferDirection(d._id, dir as 'in' | 'out')
                          const abs = Math.abs(d.amount)
                          update(d._id, 'amount', dir === 'in' ? abs : -abs)
                        }}
                      >
                        <Select.Trigger
                          className="flex items-center gap-1.5 w-full px-2 py-1.5 text-sm rounded-[6px] outline-none"
                          style={inputStyle}
                        >
                          <Select.Value />
                          <Select.Icon className="ml-auto shrink-0" style={{ color: 'var(--tx-tertiary)' }}>
                            <ChevronDown size={12} />
                          </Select.Icon>
                        </Select.Trigger>
                        <Select.Portal>
                          <Select.Content position="popper" sideOffset={4} style={{ ...selectContent, minWidth: 'var(--radix-select-trigger-width)' }}>
                            <Select.Viewport className="p-1">
                              {[{ value: 'out', label: '↑ Out' }, { value: 'in', label: '↓ In' }].map((opt) => (
                                <Select.Item
                                  key={opt.value} value={opt.value}
                                  className="px-3 py-1.5 text-sm rounded-[6px] cursor-pointer outline-none select-none"
                                  style={{ color: 'var(--tx-primary)' }}
                                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-card-alt)')}
                                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                                >
                                  <Select.ItemText>{opt.label}</Select.ItemText>
                                </Select.Item>
                              ))}
                            </Select.Viewport>
                          </Select.Content>
                        </Select.Portal>
                      </Select.Root>
                    )}
                    <CategorySelect
                      value={d.category}
                      categories={categories}
                      onChange={(v) => handleCategoryChange(d._id, v)}
                      onAddNew={() => setAddCategoryForRow(d._id)}
                    />
                    <AccountSelect
                      value={d.accountId}
                      accounts={accounts}
                      onChange={(id) => update(d._id, 'accountId', id)}
                      onAddNew={() => setAddAccountForRow(d._id)}
                    />
                    {d.transactionType === 'transfer' && (
                      <Select.Root
                        value={String(d.transferCounterpartAccountId ?? '__none__')}
                        onValueChange={(v) => update(d._id, 'transferCounterpartAccountId', v === '__none__' ? null : parseInt(v))}
                      >
                        <Select.Trigger
                          className="flex items-center gap-1.5 w-full px-2 py-1.5 text-sm rounded-[6px] outline-none"
                          style={inputStyle}
                        >
                          <Select.Value placeholder={getTransferDirection(d) === 'out' ? 'To account…' : 'From account…'} />
                          <Select.Icon className="ml-auto shrink-0" style={{ color: 'var(--tx-tertiary)' }}>
                            <ChevronDown size={12} />
                          </Select.Icon>
                        </Select.Trigger>
                        <Select.Portal>
                          <Select.Content position="popper" sideOffset={4} style={{ ...selectContent, minWidth: 'var(--radix-select-trigger-width)' }}>
                            <Select.Viewport className="p-1">
                              <Select.Item
                                value="__none__"
                                className="px-3 py-1.5 text-sm rounded-[6px] cursor-pointer outline-none select-none"
                                style={{ color: 'var(--tx-faint)' }}
                                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-card-alt)')}
                                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                              >
                                <Select.ItemText>— none —</Select.ItemText>
                              </Select.Item>
                              {accounts
                                .filter((a) => a.id !== d.accountId)
                                .map((a) => (
                                  <Select.Item
                                    key={a.id} value={String(a.id)}
                                    className="px-3 py-1.5 text-sm rounded-[6px] cursor-pointer outline-none select-none"
                                    style={{ color: 'var(--tx-primary)' }}
                                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-card-alt)')}
                                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                                  >
                                    <Select.ItemText>{a.name}</Select.ItemText>
                                  </Select.Item>
                                ))}
                            </Select.Viewport>
                          </Select.Content>
                        </Select.Portal>
                      </Select.Root>
                    )}
                  </div>

                  {/* Delete */}
                  <button
                    onClick={() => remove(d._id)}
                    className="shrink-0 mt-0.5 transition-opacity hover:opacity-60"
                    style={{ color: 'var(--tx-tertiary)' }}
                    aria-label="Remove row"
                  >
                    <X size={15} />
                  </button>
                </div>

                {/* Rule suggestion strip */}
                {ruleSuggestion && (
                  <div
                    className="px-4 py-2.5 space-y-2"
                    style={{ borderTop: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-card-alt)' }}
                  >
                    {/* Row 1: summary + actions */}
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium" style={{ color: 'var(--tx-secondary)' }}>
                        Save vendor rule
                      </span>
                      <span className="text-xs px-1.5 py-0.5 rounded-[4px]" style={{ backgroundColor: 'var(--bg-badge-committed)', color: 'var(--tx-badge-committed)' }}>
                        {ruleSuggestion.category}
                      </span>
                      <div className="ml-auto flex items-center gap-2">
                        <button
                          onClick={() => handleSaveRule(d._id)}
                          disabled={savingRuleId === d._id}
                          className="px-2.5 py-0.5 text-xs rounded-[4px] font-medium disabled:opacity-40"
                          style={{ backgroundColor: 'var(--bg-btn)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}
                        >
                          {savingRuleId === d._id ? '…' : 'Save'}
                        </button>
                        <button
                          onClick={() => dismissRuleSuggestion(d._id)}
                          className="transition-opacity hover:opacity-60"
                          style={{ color: 'var(--tx-tertiary)' }}
                        >
                          <X size={11} />
                        </button>
                      </div>
                    </div>
                    {/* Row 2: editable fields */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <input
                        type="text"
                        value={ruleSuggestion.pattern}
                        onChange={(e) => updateRuleSuggestion(d._id, 'pattern', e.target.value)}
                        placeholder="Pattern"
                        className="flex-1 min-w-0 px-2 py-1 text-xs rounded-[4px] outline-none font-mono"
                        style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }}
                        title="Text pattern to match against transaction descriptions"
                      />
                      <input
                        type="text"
                        value={ruleSuggestion.vendor}
                        onChange={(e) => updateRuleSuggestion(d._id, 'vendor', e.target.value)}
                        placeholder="Vendor name"
                        className="w-32 px-2 py-1 text-xs rounded-[4px] outline-none"
                        style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }}
                        title="Display name for this vendor"
                      />
                      <Select.Root value={ruleSuggestion.matchType} onValueChange={(v) => updateRuleSuggestion(d._id, 'matchType', v)}>
                        <Select.Trigger
                          className="flex items-center gap-1.5 px-2 py-1 text-xs rounded-[4px] outline-none whitespace-nowrap"
                          style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }}
                          title="How to match the pattern"
                        >
                          <Select.Value />
                          <Select.Icon className="ml-1 shrink-0" style={{ color: 'var(--tx-tertiary)' }}>
                            <ChevronDown size={10} />
                          </Select.Icon>
                        </Select.Trigger>
                        <Select.Portal>
                          <Select.Content position="popper" sideOffset={4} style={{ ...selectContent, minWidth: 'var(--radix-select-trigger-width)' }}>
                            <Select.Viewport className="p-1">
                              {['contains', 'starts-with', 'ends-with', 'exact', 'regex'].map((mt) => (
                                <Select.Item
                                  key={mt} value={mt}
                                  className="px-3 py-1.5 text-xs rounded-[6px] cursor-pointer outline-none select-none"
                                  style={{ color: 'var(--tx-primary)' }}
                                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-card-alt)')}
                                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                                >
                                  <Select.ItemText>{mt}</Select.ItemText>
                                </Select.Item>
                              ))}
                            </Select.Viewport>
                          </Select.Content>
                        </Select.Portal>
                      </Select.Root>
                    </div>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      {error && (
        <p className="text-sm px-4 py-2 rounded-[8px]" style={{ backgroundColor: 'var(--bg-notify-error)', color: 'var(--tx-notify-error)' }}>
          {error}
        </p>
      )}

      <div className="flex items-center gap-3 pt-2">
        <button
          onClick={addRow}
          className="px-[12px] py-[7px] text-sm rounded-[8px] transition-colors duration-150"
          style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-card)', color: 'var(--tx-primary)' }}
        >
          + Add row
        </button>
        <button
          onClick={onDiscard}
          className="px-[12px] py-[7px] text-sm rounded-[8px] transition-colors duration-150"
          style={{ color: 'var(--tx-secondary)' }}
        >
          Discard
        </button>
        <button
          onClick={handleCommit}
          disabled={committing || drafts.length === 0}
          className="ml-auto px-[14px] py-[10px] rounded-[8px] text-sm font-semibold transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ backgroundColor: 'var(--bg-btn)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}
        >
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
