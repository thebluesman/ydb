'use client'

import { memo, useCallback, useState, useEffect, useRef } from 'react'
import { X, ChevronDown, Plus, Check } from 'lucide-react'
import * as RSelect from '@radix-ui/react-select'
import { DatePicker } from '@/app/_components/DatePicker'
import { Select, Button, Modal, Field, Input } from '@/app/_components/ui'
import { toCents } from '@/lib/money'

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
  transactionType === 'transfer' ? 'var(--tx-transfer)' : amt < 0 ? 'var(--tx-error)' : amt > 0 ? 'var(--tx-success)' : 'var(--tx-tertiary)'

const inputStyle = { border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }
// Dropdowns use the ambient (raised) shadow so modals still read as "above".
const selectContent: React.CSSProperties = {
  backgroundColor: 'var(--bg-card)',
  border: '1px solid var(--border-warm)',
  boxShadow: 'var(--shadow-ambient)',
  borderRadius: '8px',
  zIndex: 9999,
}

// ── Row Text Input (local state to avoid full-table re-renders on each keystroke) ──

function RowTextInput({ value, onChange, ...props }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & { value: string; onChange: (v: string) => void }) {
  // Derived-state pattern: store the externally-supplied value alongside local
  // edits so we can detect an external change and reset without an effect.
  const [state, setState] = useState({ external: value, local: value })
  if (state.external !== value) {
    setState({ external: value, local: value })
  }
  return (
    <input
      {...props}
      value={state.local}
      onChange={(e) => setState((s) => ({ ...s, local: e.target.value }))}
      onBlur={(e) => {
        onChange(state.local)
        props.onBlur?.(e)
      }}
    />
  )
}

function RowAmountInput({ value, onCommit, style, className }: {
  value: number
  onCommit: (v: number) => void
  style: React.CSSProperties
  className: string
}) {
  const [state, setState] = useState({ external: value, local: String(Math.abs(value)) })
  if (state.external !== value && parseFloat(state.local) !== Math.abs(value)) {
    setState({ external: value, local: String(Math.abs(value)) })
  }
  return (
    <input
      type="number"
      step="0.01"
      min="0"
      value={state.local}
      onChange={(e) => setState((s) => ({ ...s, local: e.target.value }))}
      onBlur={() => onCommit(Math.abs(parseFloat(state.local) || 0))}
      className={className}
      style={style}
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

  return (
    <Modal open onClose={onClose} title="New category" maxWidth={384} className="space-y-4">
      <Field label="Name">
        <Input
          autoFocus
          type="text"
          value={name}
          onChange={(e) => { setName(e.target.value); setError('') }}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          placeholder="e.g. Groceries"
        />
        {error && <p className="mt-1 text-xs" style={{ color: 'var(--tx-error)' }}>{error}</p>}
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={handleSubmit} disabled={saving}>
          {saving ? '…' : 'Add'}
        </Button>
      </div>
    </Modal>
  )
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
    <RSelect.Root
      value={value}
      onValueChange={handleChange}
      onOpenChange={(open) => { if (!open) setSearch('') }}
    >
      <RSelect.Trigger
        className="flex items-center gap-1.5 w-full px-2 py-1.5 text-sm rounded-[6px] outline-none"
        style={inputStyle}
      >
        <span className="flex-1 truncate text-left">{value}</span>
        <RSelect.Icon className="ml-auto shrink-0" style={{ color: 'var(--tx-tertiary)' }}>
          <ChevronDown size={12} />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content
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
          <RSelect.Viewport className="p-1" style={{ maxHeight: 220, overflowY: 'auto' }}>
            {!hasValue && !q && !!value && (
              <RSelect.Item
                value={value}
                className="ui-select-item flex items-center gap-2 px-3 py-1.5 text-sm rounded-[6px] cursor-pointer outline-none select-none"
                style={{ color: 'var(--tx-primary)' }}
              >
                <Check size={12} style={{ flexShrink: 0, color: 'var(--tx-secondary)' }} />
                <RSelect.ItemText>{value}</RSelect.ItemText>
              </RSelect.Item>
            )}
            {filtered.map((c) => (
              <RSelect.Item
                key={c.id} value={c.name}
                className="ui-select-item flex items-center gap-2 px-3 py-1.5 text-sm rounded-[6px] cursor-pointer outline-none select-none"
                style={{ color: 'var(--tx-primary)' }}
              >
                <span style={{ width: 12, flexShrink: 0 }}>
                  {c.name === value && <Check size={12} style={{ color: 'var(--tx-secondary)' }} />}
                </span>
                <RSelect.ItemText>{c.name}</RSelect.ItemText>
              </RSelect.Item>
            ))}
            {filtered.length === 0 && (
              <div className="px-3 py-2 text-sm" style={{ color: 'var(--tx-tertiary)' }}>No matches</div>
            )}
            <RSelect.Separator style={{ height: '1px', backgroundColor: 'var(--border-warm)', margin: '4px 0' }} />
            <RSelect.Item
              value={ADD_NEW_SENTINEL}
              className="ui-select-item flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-[6px] cursor-pointer outline-none select-none"
              style={{ color: 'var(--tx-secondary)' }}
            >
              <Plus size={12} />
              <RSelect.ItemText>Add new category</RSelect.ItemText>
            </RSelect.Item>
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
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

  const nativeSelect = 'w-full px-3 py-2 text-sm rounded-[8px] outline-none'

  return (
    <Modal open onClose={onClose} title="New account" maxWidth={384} className="space-y-4">
      <div className="space-y-3">
        <Field label="Name">
          <Input
            autoFocus
            type="text"
            value={name}
            onChange={(e) => { setName(e.target.value); setError('') }}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            placeholder="e.g. Cash Wallet"
          />
        </Field>
        <div className="flex gap-3">
          <Field label="Type" className="flex-1">
            <select
              value={accountType}
              onChange={(e) => setType(e.target.value)}
              className={nativeSelect}
              style={inputStyle}
            >
              {ACCOUNT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>
          <Field label="Currency">
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className={nativeSelect}
              style={inputStyle}
            >
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
        </div>
        {error && <p className="text-xs" style={{ color: 'var(--tx-error)' }}>{error}</p>}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={handleSubmit} disabled={saving}>
          {saving ? '…' : 'Add'}
        </Button>
      </div>
    </Modal>
  )
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
    <RSelect.Root value={String(value)} onValueChange={handleChange}>
      <RSelect.Trigger
        className="flex items-center gap-1.5 w-full px-2 py-1.5 text-sm rounded-[6px] outline-none"
        style={inputStyle}
      >
        <RSelect.Value />
        <RSelect.Icon className="ml-auto shrink-0" style={{ color: 'var(--tx-tertiary)' }}>
          <ChevronDown size={12} />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content position="popper" sideOffset={4} style={{ ...selectContent, minWidth: 'var(--radix-select-trigger-width)' }}>
          <RSelect.Viewport className="p-1">
            {accounts.map((a) => (
              <RSelect.Item
                key={a.id} value={String(a.id)}
                className="ui-select-item px-3 py-1.5 text-sm rounded-[6px] cursor-pointer outline-none select-none"
                style={{ color: 'var(--tx-primary)' }}
              >
                <RSelect.ItemText>{a.name}</RSelect.ItemText>
              </RSelect.Item>
            ))}
            <RSelect.Separator style={{ height: '1px', backgroundColor: 'var(--border-warm)', margin: '4px 0' }} />
            <RSelect.Item
              value={ADD_NEW_ACCOUNT_SENTINEL}
              className="ui-select-item flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-[6px] cursor-pointer outline-none select-none"
              style={{ color: 'var(--tx-secondary)' }}
            >
              <Plus size={12} />
              <RSelect.ItemText>Add new account</RSelect.ItemText>
            </RSelect.Item>
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  )
}

// ── Type Select ───────────────────────────────────────────────────────────────

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

// ── Row (memoized) ────────────────────────────────────────────────────────────
//
// Each row owns local state for its text inputs (RowTextInput / RowAmountInput)
// and only commits to the parent on blur. With the row also wrapped in
// React.memo, an edit to one row no longer re-renders the other rows or their
// nested Radix Select trees — which is what was hanging the page on large
// statements.

type RowProps = {
  draft: DraftTransaction
  isFirst: boolean
  isDuplicate: boolean
  ruleSuggestion: RuleSuggestion | null
  transferDirection: 'in' | 'out'
  isNotesExpanded: boolean
  savingRule: boolean
  categories: Category[]
  accounts: Account[]
  onUpdate: (id: string, field: keyof DraftTransaction, value: string | number | null) => void
  onRemove: (id: string) => void
  onTypeChange: (id: string, type: string) => void
  onTransferDirChange: (id: string, dir: 'in' | 'out') => void
  onCategoryChange: (id: string, cat: string) => void
  onExpandNotes: (id: string) => void
  onDismissDuplicate: (id: string) => void
  onAddCategoryForRow: (id: string) => void
  onAddAccountForRow: (id: string) => void
  onSaveRule: (id: string) => void
  onDismissRule: (id: string) => void
  onUpdateRuleField: (id: string, field: keyof RuleSuggestion, value: string) => void
}

const Row = memo(function Row({
  draft: d, isFirst, isDuplicate, ruleSuggestion, transferDirection,
  isNotesExpanded, savingRule, categories, accounts,
  onUpdate, onRemove, onTypeChange, onTransferDirChange,
  onCategoryChange, onExpandNotes, onDismissDuplicate,
  onAddCategoryForRow, onAddAccountForRow,
  onSaveRule, onDismissRule, onUpdateRuleField,
}: RowProps) {
  return (
    <div
      style={{
        borderTop: isFirst ? undefined : '1px solid var(--border-warm)',
        backgroundColor: 'var(--bg-card)',
      }}
    >
      {isDuplicate && (
        <div
          className="flex items-center justify-between px-4 py-1.5"
          style={{ backgroundColor: 'var(--bg-badge-review)', borderBottom: '1px solid var(--border-warm)' }}
        >
          <span className="text-xs" style={{ color: 'var(--tx-badge-review)' }}>
            Possible duplicate — verify before committing
          </span>
          <button
            onClick={() => onDismissDuplicate(d._id)}
            className="btn text-xs underline transition-opacity hover:opacity-70"
            style={{ color: 'var(--tx-badge-review)' }}
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="flex gap-4 px-4 py-3 items-start">
        <div className="shrink-0 space-y-2" style={{ width: 148 }}>
          <DatePicker
            value={d.date}
            onChange={(v) => onUpdate(d._id, 'date', v)}
            style={{ width: '100%' }}
          />
          <TypeSelect
            value={d.transactionType}
            onChange={(v) => onTypeChange(d._id, v)}
          />
        </div>

        <div className="flex-1 min-w-0 space-y-2">
          <RowTextInput
            type="text"
            value={d.description}
            onChange={(v) => onUpdate(d._id, 'description', v)}
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
          {isNotesExpanded ? (
            <RowTextInput
              type="text"
              value={d.notes}
              onChange={(v) => onUpdate(d._id, 'notes', v)}
              placeholder="Notes (optional)"
              className={inputCls}
              style={{ ...inputStyle, fontStyle: 'italic' }}
              autoFocus={!d.notes}
            />
          ) : (
            <button
              type="button"
              onClick={() => onExpandNotes(d._id)}
              className="btn text-xs py-0.5 text-left transition-opacity duration-100 hover:opacity-80"
              style={{ color: 'var(--tx-faint)' }}
            >
              + Add note
            </button>
          )}
        </div>

        <div className="shrink-0 space-y-2" style={{ width: 176 }}>
          <RowAmountInput
            value={d.amount}
            onCommit={(abs) => {
              let signed: number
              if (d.transactionType === 'debit') signed = -abs
              else if (d.transactionType === 'credit') signed = abs
              else signed = transferDirection === 'in' ? abs : -abs
              onUpdate(d._id, 'amount', signed)
            }}
            className={`${inputCls} font-mono text-right`}
            style={{ ...inputStyle, color: amountColor(d.amount, d.transactionType) }}
          />
          {d.transactionType === 'transfer' && (
            <Select
              value={transferDirection}
              onValueChange={(dir) => onTransferDirChange(d._id, dir as 'in' | 'out')}
              options={[{ value: 'out', label: '↑ Out' }, { value: 'in', label: '↓ In' }]}
              ariaLabel="Transfer direction"
            />
          )}
          <CategorySelect
            value={d.category}
            categories={categories}
            onChange={(v) => onCategoryChange(d._id, v)}
            onAddNew={() => onAddCategoryForRow(d._id)}
          />
          <AccountSelect
            value={d.accountId}
            accounts={accounts}
            onChange={(id) => onUpdate(d._id, 'accountId', id)}
            onAddNew={() => onAddAccountForRow(d._id)}
          />
          {d.transactionType === 'transfer' && (
            <Select
              value={String(d.transferCounterpartAccountId ?? '__none__')}
              onValueChange={(v) => onUpdate(d._id, 'transferCounterpartAccountId', v === '__none__' ? null : parseInt(v))}
              ariaLabel={transferDirection === 'out' ? 'To account' : 'From account'}
              options={[
                { value: '__none__', label: '— none —', itemColor: 'var(--tx-faint)' },
                ...accounts
                  .filter((a) => a.id !== d.accountId)
                  .map((a) => ({ value: String(a.id), label: a.name })),
              ]}
              placeholder={transferDirection === 'out' ? 'To account…' : 'From account…'}
            />
          )}
        </div>

        <button
          onClick={() => onRemove(d._id)}
          className="shrink-0 mt-0.5 transition-opacity hover:opacity-60"
          style={{ color: 'var(--tx-tertiary)' }}
          aria-label="Remove row"
        >
          <X size={15} />
        </button>
      </div>

      {ruleSuggestion && (
        <div
          className="px-4 py-2.5 space-y-2"
          style={{ borderTop: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-card-alt)' }}
        >
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium" style={{ color: 'var(--tx-secondary)' }}>
              Save vendor rule
            </span>
            <span className="text-xs px-1.5 py-0.5 rounded-[4px]" style={{ backgroundColor: 'var(--bg-badge-committed)', color: 'var(--tx-badge-committed)' }}>
              {ruleSuggestion.category}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={() => onSaveRule(d._id)}
                disabled={savingRule}
                className="btn px-2.5 py-0.5 text-xs rounded-[4px] font-medium disabled:opacity-40"
                style={{ backgroundColor: 'var(--bg-btn)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}
              >
                {savingRule ? '…' : 'Save'}
              </button>
              <button
                onClick={() => onDismissRule(d._id)}
                className="transition-opacity hover:opacity-60"
                style={{ color: 'var(--tx-tertiary)' }}
              >
                <X size={11} />
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="text"
              defaultValue={ruleSuggestion.pattern}
              onBlur={(e) => onUpdateRuleField(d._id, 'pattern', e.target.value)}
              placeholder="Pattern"
              className="flex-1 min-w-0 px-2 py-1 text-xs rounded-[4px] outline-none font-mono"
              style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }}
              title="Text pattern to match against transaction descriptions"
            />
            <input
              type="text"
              defaultValue={ruleSuggestion.vendor}
              onBlur={(e) => onUpdateRuleField(d._id, 'vendor', e.target.value)}
              placeholder="Vendor name"
              className="w-32 px-2 py-1 text-xs rounded-[4px] outline-none"
              style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }}
              title="Display name for this vendor"
            />
            <Select
              value={ruleSuggestion.matchType}
              onValueChange={(v) => onUpdateRuleField(d._id, 'matchType', v)}
              options={['contains', 'starts-with', 'ends-with', 'exact', 'regex'].map((mt) => ({ value: mt, label: mt }))}
              size="xs"
              fullWidth={false}
              className="whitespace-nowrap"
              ariaLabel="How to match the pattern"
            />
          </div>
        </div>
      )}
    </div>
  )
})

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

  // Refs let stable useCallback handlers read latest state without listing it
  // as a dep. Without this, every keystroke would invalidate every callback
  // and defeat React.memo on rows.
  const draftsRef = useRef(drafts); draftsRef.current = drafts
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange
  const ruleSuggestionsRef = useRef(ruleSuggestions); ruleSuggestionsRef.current = ruleSuggestions
  const dismissedRulesRef = useRef(dismissedRules); dismissedRulesRef.current = dismissedRules
  const transferDirRef = useRef(transferDirections); transferDirRef.current = transferDirections

  useEffect(() => {
    if (drafts.length === 0) return
    const candidates = drafts.map((d) => ({
      _id: d._id, date: d.date, amount: toCents(d.amount),
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

  const update = useCallback((id: string, field: keyof DraftTransaction, value: string | number | null) => {
    onChangeRef.current(draftsRef.current.map((d) => (d._id === id ? { ...d, [field]: value } : d)))
  }, [])

  const remove = useCallback((id: string) => {
    onChangeRef.current(draftsRef.current.filter((d) => d._id !== id))
    setDuplicateIds((prev) => { const n = new Set(prev); n.delete(id); return n })
    setDismissedIds((prev) => { const n = new Set(prev); n.delete(id); return n })
    setExpandedNotes((prev) => { const n = new Set(prev); n.delete(id); return n })
    setTransferDirections((prev) => { const n = new Map(prev); n.delete(id); return n })
  }, [])

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

  const dismissDuplicate = useCallback((id: string) => {
    setDismissedIds((prev) => new Set([...prev, id]))
  }, [])

  const expandNotes = useCallback((id: string) => {
    setExpandedNotes((prev) => new Set([...prev, id]))
  }, [])

  const handleCategoryChange = useCallback((id: string, newCategory: string) => {
    onChangeRef.current(draftsRef.current.map((d) => (d._id === id ? { ...d, category: newCategory } : d)))
    if (dismissedRulesRef.current.has(id)) return
    const draft = draftsRef.current.find((d) => d._id === id)
    const rawText = (draft?.originalDescription || draft?.description || '').trim()
    const displayName = (draft?.description || '').trim()
    if (!rawText) return
    setRuleSuggestions((prev) => new Map(prev).set(id, {
      pattern: rawText,
      vendor: displayName || rawText,
      category: newCategory,
      matchType: 'contains',
    }))
  }, [])

  const handleTypeChange = useCallback((id: string, type: string) => {
    const d = draftsRef.current.find((x) => x._id === id)
    if (!d) return
    const abs = Math.abs(d.amount)
    let newAmount: number
    if (type === 'debit') newAmount = -abs
    else if (type === 'credit') newAmount = abs
    else {
      const dir = transferDirRef.current.get(id) ?? (d.amount >= 0 ? 'in' : 'out')
      newAmount = dir === 'in' ? abs : -abs
    }
    onChangeRef.current(draftsRef.current.map((x) => x._id === id ? {
      ...x, transactionType: type, amount: newAmount,
      ...(type !== 'transfer' ? { transferCounterpartAccountId: null } : {}),
    } : x))
  }, [])

  const handleTransferDirChange = useCallback((id: string, dir: 'in' | 'out') => {
    setTransferDirections((prev) => new Map(prev).set(id, dir))
    const d = draftsRef.current.find((x) => x._id === id)
    if (!d) return
    const abs = Math.abs(d.amount)
    onChangeRef.current(draftsRef.current.map((x) => x._id === id ? { ...x, amount: dir === 'in' ? abs : -abs } : x))
  }, [])

  const updateRuleSuggestion = useCallback((id: string, field: keyof RuleSuggestion, value: string) => {
    setRuleSuggestions((prev) => {
      const existing = prev.get(id)
      if (!existing) return prev
      return new Map(prev).set(id, { ...existing, [field]: value })
    })
  }, [])

  const dismissRuleSuggestion = useCallback((id: string) => {
    setRuleSuggestions((prev) => { const n = new Map(prev); n.delete(id); return n })
    setDismissedRules((prev) => new Set([...prev, id]))
  }, [])

  const handleSaveRule = useCallback(async (id: string) => {
    const suggestion = ruleSuggestionsRef.current.get(id)
    if (!suggestion) return
    const draft = draftsRef.current.find((d) => d._id === id)
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
  }, [dismissRuleSuggestion])

  const openAddCategoryForRow = useCallback((id: string) => setAddCategoryForRow(id), [])
  const openAddAccountForRow = useCallback((id: string) => setAddAccountForRow(id), [])

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
        <h2 className="text-section">
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
            const dir = transferDirections.get(d._id) ?? (d.amount >= 0 ? 'in' : 'out')
            return (
              <Row
                key={d._id}
                draft={d}
                isFirst={idx === 0}
                isDuplicate={isDuplicate}
                ruleSuggestion={ruleSuggestion}
                transferDirection={dir}
                isNotesExpanded={expandedNotes.has(d._id)}
                savingRule={savingRuleId === d._id}
                categories={categories}
                accounts={accounts}
                onUpdate={update}
                onRemove={remove}
                onTypeChange={handleTypeChange}
                onTransferDirChange={handleTransferDirChange}
                onCategoryChange={handleCategoryChange}
                onExpandNotes={expandNotes}
                onDismissDuplicate={dismissDuplicate}
                onAddCategoryForRow={openAddCategoryForRow}
                onAddAccountForRow={openAddAccountForRow}
                onSaveRule={handleSaveRule}
                onDismissRule={dismissRuleSuggestion}
                onUpdateRuleField={updateRuleSuggestion}
              />
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
        <Button variant="default" size="sm" onClick={addRow}>
          + Add row
        </Button>
        <Button variant="ghost" size="sm" onClick={onDiscard}>
          Discard
        </Button>
        <Button
          variant="primary"
          size="md"
          onClick={handleCommit}
          disabled={committing || drafts.length === 0}
          className="ml-auto"
        >
          {committing ? 'Saving…' : `Commit ${drafts.length} transaction${drafts.length !== 1 ? 's' : ''}`}
        </Button>
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

