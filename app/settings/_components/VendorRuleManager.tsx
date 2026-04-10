'use client'

import { useState, useMemo } from 'react'
import * as Select from '@radix-ui/react-select'
import { AlertCircle, ChevronDown, ChevronRight, X, FlaskConical } from 'lucide-react'
import { pillTextColor } from '@/lib/category-colors'

type VendorRule = {
  id: number
  pattern: string
  matchType: string
  vendor: string
  category: string
  direction: string
  transactionType: string | null
  minAmount: number | null
  maxAmount: number | null
  priority: number
  matchCount: number
}

type Category = { id: number; name: string; color: string }

type TestRow = { id: number; date: string; description: string; originalDescription: string | null; amount: number; category: string }

const MATCH_TYPES = [
  { value: 'contains',    label: 'Contains',    badge: '~' },
  { value: 'starts-with', label: 'Starts with', badge: '^' },
  { value: 'ends-with',   label: 'Ends with',   badge: '$' },
  { value: 'exact',       label: 'Exact',       badge: '=' },
  { value: 'regex',       label: 'Regex',       badge: '.*' },
]

const DIRECTIONS = [
  { value: 'either', label: 'Either direction' },
  { value: 'debit',  label: 'Debit only (expense)' },
  { value: 'credit', label: 'Credit only (income)' },
]

function matchTypeBadge(mt: string) {
  return MATCH_TYPES.find((m) => m.value === mt)?.badge ?? mt
}

const inputStyle: React.CSSProperties = {
  border: '1px solid var(--border-warm)',
  backgroundColor: 'var(--bg-input)',
  color: 'var(--tx-primary)',
}

function SimpleSelect({
  value,
  onChange,
  options,
  placeholder,
  width,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
  width?: string
}) {
  return (
    <Select.Root value={value} onValueChange={onChange}>
      <Select.Trigger
        className="flex items-center gap-1.5 px-2 py-1.5 text-xs rounded-[6px] outline-none"
        style={{ ...inputStyle, minWidth: width ?? '120px' }}
      >
        <Select.Value placeholder={placeholder ?? ''} />
        <Select.Icon className="ml-auto" style={{ color: 'var(--tx-tertiary)' }}>
          <ChevronDown size={12} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper" sideOffset={4}
          className="rounded-[8px] z-50 overflow-hidden"
          style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-warm)', boxShadow: 'var(--shadow-card)', minWidth: 'var(--radix-select-trigger-width)' }}
        >
          <Select.Viewport className="p-1">
            {options.map((o) => (
              <Select.Item
                key={o.value} value={o.value}
                className="px-3 py-1.5 text-xs rounded-[6px] cursor-pointer outline-none select-none transition-colors duration-100"
                style={{ color: 'var(--tx-primary)' }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-card-alt)')}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
              >
                <Select.ItemText>{o.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  )
}

export function VendorRuleManager({
  rules,
  categories,
  currency,
}: {
  rules: VendorRule[]
  categories: Category[]
  currency: string
}) {
  const [list, setList] = useState<VendorRule[]>(rules)

  // Add form
  const [addVendor, setAddVendor]         = useState('')
  const [addPattern, setAddPattern]       = useState('')
  const [addCategory, setAddCategory]     = useState('')
  const [addMatchType, setAddMatchType]   = useState('contains')
  const [addDirection, setAddDirection]   = useState('either')
  const [addTransactionType, setAddTransactionType] = useState('none')
  const [addMinAmount, setAddMinAmount]   = useState('')
  const [addMaxAmount, setAddMaxAmount]   = useState('')
  const [showAdvanced, setShowAdvanced]   = useState(false)
  const [adding, setAdding]               = useState(false)
  const [addError, setAddError]           = useState('')

  // Inline edit
  const [editingRuleId, setEditingRuleId] = useState<number | null>(null)
  const [editDraft, setEditDraft]         = useState<Partial<VendorRule>>({})
  const [editSaving, setEditSaving]       = useState(false)

  // Test panel
  const [testingRuleId, setTestingRuleId] = useState<number | null>(null)
  const [testResults, setTestResults]     = useState<{ total: number; transactions: TestRow[] } | null>(null)
  const [testLoading, setTestLoading]     = useState(false)

  // Collapsed vendor groups
  const [collapsed, setCollapsed]         = useState<Set<string>>(new Set())

  const allCategories = [...new Set([...categories.map((c) => c.name), 'Income', 'Other'])]

  // Group rules by vendor, sorted by priority then id
  const groups = useMemo<[string, VendorRule[]][]>(() => {
    const map = new Map<string, VendorRule[]>()
    for (const r of list) {
      if (!map.has(r.vendor)) map.set(r.vendor, [])
      map.get(r.vendor)!.push(r)
    }
    for (const rs of map.values()) rs.sort((a, b) => a.priority - b.priority || a.id - b.id)
    return [...map.entries()].sort(([, a], [, b]) =>
      a[0].priority - b[0].priority || a[0].vendor.localeCompare(b[0].vendor)
    )
  }, [list])

  // ── Add ──────────────────────────────────────────────────────────────────────

  const handleAdd = async () => {
    const v = addVendor.trim()
    const p = addPattern.trim()
    if (!v) { setAddError('Display name required'); return }
    if (!p) { setAddError('Pattern required'); return }
    if (!addCategory) { setAddError('Category required'); return }

    setAdding(true); setAddError('')
    try {
      const res = await fetch('/api/vendor-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vendor: v, pattern: p, category: addCategory,
          matchType: addMatchType, direction: addDirection,
          transactionType: addTransactionType === 'none' ? null : addTransactionType,
          minAmount: addMinAmount ? parseFloat(addMinAmount) : null,
          maxAmount: addMaxAmount ? parseFloat(addMaxAmount) : null,
          priority: 0,
        }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error ?? 'Failed to add rule')
      }
      const rule: VendorRule = await res.json()
      setList((prev) => [...prev, rule])
      setAddVendor(''); setAddPattern(''); setAddCategory('')
      setAddMatchType('contains'); setAddDirection('either')
      setAddTransactionType('')
      setAddMinAmount(''); setAddMaxAmount('')
      setShowAdvanced(false)
    } catch (e) {
      setAddError(String(e instanceof Error ? e.message : e))
    } finally {
      setAdding(false)
    }
  }

  // ── Add pattern to existing vendor ───────────────────────────────────────────

  const prefillVendor = (vendorName: string) => {
    setAddVendor(vendorName)
    // Set category to match the vendor's existing category
    const existing = list.find((r) => r.vendor === vendorName)
    if (existing) setAddCategory(existing.category)
    setAddPattern('')
    setShowAdvanced(true)
    // Scroll add form into view
    document.getElementById('vendor-rule-add-form')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  // ── Edit ─────────────────────────────────────────────────────────────────────

  const startEdit = (rule: VendorRule) => {
    setEditingRuleId(rule.id)
    setEditDraft({
      pattern: rule.pattern, matchType: rule.matchType, direction: rule.direction,
      minAmount: rule.minAmount, maxAmount: rule.maxAmount, category: rule.category,
    })
    setTestingRuleId(null)
  }

  const saveEdit = async (rule: VendorRule) => {
    setEditSaving(true)
    try {
      const res = await fetch('/api/vendor-rules', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: rule.id, ...editDraft }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error ?? 'Failed to update')
      }
      const updated = await res.json()
      setList((prev) => prev.map((r) => r.id === rule.id ? { ...r, ...updated } : r))
      setEditingRuleId(null)
    } catch (e) {
      setAddError(String(e instanceof Error ? e.message : e))
    } finally {
      setEditSaving(false)
    }
  }

  const savePriority = async (rule: VendorRule, value: string) => {
    const priority = parseInt(value)
    if (isNaN(priority)) return
    setList((prev) => prev.map((r) => r.id === rule.id ? { ...r, priority } : r))
    await fetch('/api/vendor-rules', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: rule.id, priority }),
    })
  }

  const saveCategory = async (rule: VendorRule, category: string) => {
    setList((prev) => prev.map((r) => r.id === rule.id ? { ...r, category } : r))
    await fetch('/api/vendor-rules', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: rule.id, category }),
    })
  }

  // ── Delete ───────────────────────────────────────────────────────────────────

  const handleDelete = async (id: number) => {
    try {
      await fetch(`/api/vendor-rules?id=${id}`, { method: 'DELETE' })
      setList((prev) => prev.filter((r) => r.id !== id))
      if (editingRuleId === id) setEditingRuleId(null)
      if (testingRuleId === id) setTestingRuleId(null)
    } catch {
      setAddError('Failed to delete')
    }
  }

  // ── Test ─────────────────────────────────────────────────────────────────────

  const runTest = async (rule: VendorRule) => {
    if (testingRuleId === rule.id) { setTestingRuleId(null); return }
    setTestingRuleId(rule.id)
    setTestResults(null)
    setTestLoading(true)
    try {
      const res = await fetch(`/api/vendor-rules/test?id=${rule.id}`)
      const data = await res.json()
      setTestResults(data)
    } catch { /* silent */ } finally {
      setTestLoading(false)
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  const catColor = (name: string) =>
    categories.find((c) => c.name === name)?.color ?? '#6750A4'

  const amtLabel = (r: VendorRule) => {
    if (r.minAmount !== null && r.maxAmount !== null) return `${r.minAmount}–${r.maxAmount}`
    if (r.minAmount !== null) return `≥ ${r.minAmount}`
    if (r.maxAmount !== null) return `≤ ${r.maxAmount}`
    return null
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      <p className="text-xs" style={{ color: 'var(--tx-secondary)' }}>
        Patterns are evaluated in priority order (lowest number first). The first match wins and sets the display name and category.
      </p>

      {list.length === 0 && (
        <p className="text-sm" style={{ color: 'var(--tx-faint)' }}>No patterns yet.</p>
      )}

      {groups.length > 0 && (
        <div className="rounded-[8px] overflow-hidden" style={{ border: '1px solid var(--border-warm)' }}>
          {groups.map(([vendorName, vendorRules], gi) => {
            const isCollapsed = collapsed.has(vendorName)
            const totalMatched = vendorRules.reduce((s, r) => s + r.matchCount, 0)
            const repRule = vendorRules[0]

            return (
              <div key={vendorName}>
                {/* Group header */}
                <div
                  className="flex items-center gap-3 px-3 py-2.5"
                  style={{
                    backgroundColor: 'var(--bg-card-alt)',
                    borderTop: gi > 0 ? '1px solid var(--border-warm)' : 'none',
                  }}
                >
                  <button
                    onClick={() => setCollapsed((s) => {
                      const n = new Set(s)
                      n.has(vendorName) ? n.delete(vendorName) : n.add(vendorName)
                      return n
                    })}
                    className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
                  >
                    {isCollapsed
                      ? <ChevronRight size={13} style={{ color: 'var(--tx-tertiary)', flexShrink: 0 }} />
                      : <ChevronDown size={13} style={{ color: 'var(--tx-tertiary)', flexShrink: 0 }} />}
                    <span className="text-sm font-medium truncate" style={{ color: 'var(--tx-primary)' }}>
                      {vendorName}
                    </span>
                  </button>

                  {/* Category pill — click to edit all rules in vendor group */}
                  <button
                    onClick={() => {
                      const newCat = window.prompt(`New category for all "${vendorName}" rules:`, repRule.category)
                      if (newCat && newCat !== repRule.category) {
                        vendorRules.forEach((r) => saveCategory(r, newCat))
                      }
                    }}
                    className="text-xs px-2 py-0.5 rounded-full font-medium transition-opacity hover:opacity-80 shrink-0"
                    style={{ backgroundColor: catColor(repRule.category), color: pillTextColor(catColor(repRule.category)) }}
                    title="Click to change category for all patterns"
                  >
                    {repRule.category}
                  </button>

                  <span className="text-[11px] shrink-0" style={{ color: 'var(--tx-faint)' }}>
                    {vendorRules.length} pattern{vendorRules.length !== 1 ? 's' : ''} · {totalMatched} matched
                  </span>

                  <button
                    onClick={() => prefillVendor(vendorName)}
                    className="text-[11px] shrink-0 transition-colors hover:opacity-80"
                    style={{ color: 'var(--tx-tertiary)' }}
                    title="Add another pattern for this vendor"
                  >
                    + Add pattern
                  </button>
                </div>

                {/* Pattern rows */}
                {!isCollapsed && vendorRules.map((rule) => (
                  <div key={rule.id}>
                    {/* Main pattern row */}
                    <div
                      className="group flex items-center gap-3 pl-8 pr-3 py-2"
                      style={{ borderTop: '1px solid var(--border-warm)' }}
                      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-row-hover)')}
                      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                    >
                      {/* Priority input */}
                      <input
                        type="number"
                        defaultValue={rule.priority}
                        onBlur={(e) => savePriority(rule, e.target.value)}
                        className="w-10 px-1 py-0.5 text-[11px] text-center rounded-[4px] outline-none font-mono"
                        style={inputStyle}
                        title="Priority (lower = higher priority)"
                      />

                      {/* Pattern + match type badge */}
                      <div className="flex items-center gap-1.5 flex-1 min-w-0">
                        <span className="font-mono text-xs truncate" style={{ color: 'var(--tx-primary)' }}>
                          {rule.pattern}
                        </span>
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded-[4px] font-mono shrink-0"
                          style={{ backgroundColor: 'var(--bg-card-alt)', color: 'var(--tx-secondary)', border: '1px solid var(--border-warm)' }}
                        >
                          {matchTypeBadge(rule.matchType)}
                        </span>
                        {rule.direction !== 'either' && (
                          <span
                            className="text-[10px] px-1.5 py-0.5 rounded-[4px] shrink-0"
                            style={{
                              backgroundColor: rule.direction === 'debit' ? 'var(--bg-stat-expense)' : 'var(--bg-stat-income)',
                              color: rule.direction === 'debit' ? 'var(--tx-stat-expense)' : 'var(--tx-stat-income)',
                            }}
                          >
                            {rule.direction === 'debit' ? '↓ debit' : '↑ credit'}
                          </span>
                        )}
                        {rule.transactionType && (
                          <span
                            className="text-[10px] px-1.5 py-0.5 rounded-[4px] shrink-0 font-medium"
                            style={{
                              backgroundColor: rule.transactionType === 'transfer' ? 'rgba(245,158,11,0.15)' : rule.transactionType === 'credit' ? 'var(--bg-stat-income)' : 'var(--bg-stat-expense)',
                              color: rule.transactionType === 'transfer' ? '#F59E0B' : rule.transactionType === 'credit' ? 'var(--tx-stat-income)' : 'var(--tx-stat-expense)',
                            }}
                          >
                            → {rule.transactionType}
                          </span>
                        )}
                        {amtLabel(rule) && (
                          <span className="text-[10px] shrink-0" style={{ color: 'var(--tx-faint)' }}>
                            {amtLabel(rule)}
                          </span>
                        )}
                      </div>

                      {/* Matched count */}
                      <span className="text-[11px] shrink-0 tabular-nums" style={{ color: rule.matchCount > 0 ? 'var(--tx-faint)' : 'var(--tx-faint)', opacity: rule.matchCount === 0 ? 0.4 : 1 }}>
                        {rule.matchCount} matched
                      </span>

                      {/* Actions — visible on hover */}
                      <div className="flex items-center gap-2.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150 shrink-0">
                        <button
                          onClick={() => editingRuleId === rule.id ? setEditingRuleId(null) : startEdit(rule)}
                          className="text-xs transition-colors hover:opacity-80"
                          style={{ color: 'var(--tx-tertiary)' }}
                        >
                          {editingRuleId === rule.id ? 'Close' : 'Edit'}
                        </button>
                        <button
                          onClick={() => runTest(rule)}
                          className="transition-colors hover:opacity-80"
                          style={{ color: testingRuleId === rule.id ? 'var(--tx-secondary)' : 'var(--tx-tertiary)' }}
                          title="Test this rule against your transactions"
                        >
                          <FlaskConical size={13} />
                        </button>
                        <button
                          onClick={() => handleDelete(rule.id)}
                          className="transition-colors hover:text-error"
                          style={{ color: 'var(--tx-tertiary)' }}
                          title="Delete rule"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </div>

                    {/* Inline edit form */}
                    {editingRuleId === rule.id && (
                      <div
                        className="pl-8 pr-3 py-3 space-y-2"
                        style={{ borderTop: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-edit-row)' }}
                      >
                        <div className="flex flex-wrap gap-2 items-end">
                          <div>
                            <label className="block text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--tx-tertiary)' }}>Pattern</label>
                            <input
                              type="text"
                              value={editDraft.pattern ?? rule.pattern}
                              onChange={(e) => setEditDraft((d) => ({ ...d, pattern: e.target.value }))}
                              className="px-2 py-1 text-xs rounded-[6px] outline-none font-mono w-48"
                              style={inputStyle}
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--tx-tertiary)' }}>Match type</label>
                            <SimpleSelect
                              value={editDraft.matchType ?? rule.matchType}
                              onChange={(v) => setEditDraft((d) => ({ ...d, matchType: v }))}
                              options={MATCH_TYPES.map((m) => ({ value: m.value, label: m.label }))}
                              width="130px"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--tx-tertiary)' }}>Direction</label>
                            <SimpleSelect
                              value={editDraft.direction ?? rule.direction}
                              onChange={(v) => setEditDraft((d) => ({ ...d, direction: v }))}
                              options={DIRECTIONS}
                              width="150px"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--tx-tertiary)' }}>Min amount</label>
                            <input
                              type="number" step="0.01" placeholder="None"
                              value={editDraft.minAmount ?? rule.minAmount ?? ''}
                              onChange={(e) => setEditDraft((d) => ({ ...d, minAmount: e.target.value ? parseFloat(e.target.value) : null }))}
                              className="px-2 py-1 text-xs rounded-[6px] outline-none w-20"
                              style={inputStyle}
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--tx-tertiary)' }}>Max amount</label>
                            <input
                              type="number" step="0.01" placeholder="None"
                              value={editDraft.maxAmount ?? rule.maxAmount ?? ''}
                              onChange={(e) => setEditDraft((d) => ({ ...d, maxAmount: e.target.value ? parseFloat(e.target.value) : null }))}
                              className="px-2 py-1 text-xs rounded-[6px] outline-none w-20"
                              style={inputStyle}
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--tx-tertiary)' }}>Category</label>
                            <SimpleSelect
                              value={editDraft.category ?? rule.category}
                              onChange={(v) => setEditDraft((d) => ({ ...d, category: v }))}
                              options={allCategories.map((c) => ({ value: c, label: c }))}
                              width="130px"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--tx-tertiary)' }}>Set type</label>
                            <SimpleSelect
                              value={editDraft.transactionType ?? rule.transactionType ?? 'none'}
                              onChange={(v) => setEditDraft((d) => ({ ...d, transactionType: v === 'none' ? null : v }))}
                              options={[
                                { value: 'none', label: 'Don\'t override' },
                                { value: 'debit', label: 'Debit' },
                                { value: 'credit', label: 'Credit' },
                                { value: 'transfer', label: 'Transfer' },
                              ]}
                              width="140px"
                            />
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => saveEdit(rule)}
                            disabled={editSaving}
                            className="px-3 py-1 text-xs rounded-[6px] disabled:opacity-40"
                            style={{ backgroundColor: 'var(--bg-btn)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}
                          >
                            {editSaving ? '…' : 'Save'}
                          </button>
                          <button
                            onClick={() => setEditingRuleId(null)}
                            className="px-3 py-1 text-xs rounded-[6px]"
                            style={{ color: 'var(--tx-secondary)', border: '1px solid var(--border-warm)' }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Test panel */}
                    {testingRuleId === rule.id && (
                      <div
                        className="pl-8 pr-3 py-3"
                        style={{ borderTop: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-surface-200)' }}
                      >
                        {testLoading && (
                          <p className="text-xs" style={{ color: 'var(--tx-faint)' }}>Testing…</p>
                        )}
                        {!testLoading && testResults && (
                          <>
                            <p className="text-xs mb-2 font-medium" style={{ color: 'var(--tx-secondary)' }}>
                              {testResults.total === 0
                                ? 'No matching transactions found.'
                                : `${testResults.total} matching transaction${testResults.total !== 1 ? 's' : ''}${testResults.total > 500 ? ' (showing first 500)' : ''}`}
                            </p>
                            {testResults.transactions.length > 0 && (
                              <div
                                className="space-y-1 overflow-y-auto"
                                style={{ maxHeight: '200px' }}
                              >
                                {testResults.transactions.map((tx) => (
                                  <div
                                    key={tx.id}
                                    className="flex items-center gap-3 px-2 py-1.5 rounded-[4px] text-xs"
                                    style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-warm)' }}
                                  >
                                    <span className="font-mono shrink-0" style={{ color: 'var(--tx-tertiary)' }}>{tx.date}</span>
                                    <div className="flex-1 min-w-0">
                                      <div className="truncate" style={{ color: 'var(--tx-primary)' }}>{tx.description}</div>
                                      {tx.originalDescription && tx.originalDescription !== tx.description && (
                                        <div className="truncate text-[10px]" style={{ color: 'var(--tx-faint)' }}>{tx.originalDescription}</div>
                                      )}
                                    </div>
                                    <span
                                      className="font-mono shrink-0"
                                      style={{ color: tx.amount < 0 ? 'var(--tx-error)' : 'var(--tx-success)' }}
                                    >
                                      {tx.amount < 0 ? '−' : '+'}{currency}{Math.abs(tx.amount).toFixed(2)}
                                    </span>
                                    <span className="shrink-0" style={{ color: 'var(--tx-faint)' }}>{tx.category}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}

      {/* Add form */}
      <div
        id="vendor-rule-add-form"
        className="pt-4 space-y-3"
        style={{ borderTop: list.length > 0 ? '1px solid var(--border-warm)' : 'none' }}
      >
        {/* Primary fields */}
        <div className="flex items-end gap-2 flex-wrap">
          <div className="flex-1 min-w-[130px]">
            <label className="block text-[11px] font-medium uppercase tracking-wide mb-1" style={{ color: 'var(--tx-secondary)' }}>
              Display Name
            </label>
            <input
              type="text"
              placeholder="e.g. Netflix"
              value={addVendor}
              onChange={(e) => { setAddVendor(e.target.value); setAddError('') }}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              className="w-full px-3 py-2 text-sm rounded-[8px] outline-none transition-colors"
              style={inputStyle}
              onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--border-warm-md)')}
              onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border-warm)')}
            />
          </div>
          <div className="flex-1 min-w-[130px]">
            <label className="block text-[11px] font-medium uppercase tracking-wide mb-1" style={{ color: 'var(--tx-secondary)' }}>
              Pattern
            </label>
            <input
              type="text"
              placeholder="e.g. NETFLIX.COM"
              value={addPattern}
              onChange={(e) => { setAddPattern(e.target.value); setAddError('') }}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              className="w-full px-3 py-2 text-sm rounded-[8px] outline-none font-mono transition-colors"
              style={inputStyle}
              onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--border-warm-md)')}
              onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border-warm)')}
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium uppercase tracking-wide mb-1" style={{ color: 'var(--tx-secondary)' }}>
              Category
            </label>
            <Select.Root value={addCategory} onValueChange={setAddCategory}>
              <Select.Trigger
                className="flex items-center gap-2 px-3 py-2 text-sm rounded-[8px] outline-none min-w-[120px]"
                style={inputStyle}
              >
                <Select.Value placeholder={<span style={{ color: 'var(--tx-faint)' }}>Category</span>} />
                <Select.Icon className="ml-auto" style={{ color: 'var(--tx-tertiary)' }}>
                  <ChevronDown size={14} />
                </Select.Icon>
              </Select.Trigger>
              <Select.Portal>
                <Select.Content
                  position="popper" sideOffset={4} className="rounded-[8px] z-50 overflow-hidden"
                  style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-warm)', boxShadow: 'var(--shadow-card)' }}
                >
                  <Select.Viewport className="p-1">
                    {categories.length === 0 ? (
                      <div className="flex flex-col items-center gap-1.5 px-4 py-4">
                        <AlertCircle size={16} strokeWidth={1.5} style={{ color: 'var(--tx-tertiary)' }} />
                        <span className="text-xs" style={{ color: 'var(--tx-tertiary)' }}>No categories yet</span>
                      </div>
                    ) : allCategories.map((c) => (
                      <Select.Item
                        key={c} value={c}
                        className="px-3 py-2 text-sm rounded-[6px] cursor-pointer outline-none select-none transition-colors"
                        style={{ color: 'var(--tx-primary)' }}
                        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-card-alt)')}
                        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                      >
                        <Select.ItemText>{c}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.Viewport>
                </Select.Content>
              </Select.Portal>
            </Select.Root>
          </div>
          <button
            onClick={handleAdd}
            disabled={adding}
            className="px-3 py-[7px] text-sm rounded-[8px] transition-colors disabled:opacity-40 whitespace-nowrap"
            style={{ backgroundColor: 'var(--bg-btn)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}
          >
            {adding ? '…' : 'Add'}
          </button>
        </div>

        {/* Advanced options toggle */}
        <button
          onClick={() => setShowAdvanced((v) => !v)}
          className="flex items-center gap-1 text-xs transition-opacity hover:opacity-100"
          style={{ color: 'var(--tx-tertiary)', opacity: 0.75 }}
        >
          {showAdvanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Advanced options
        </button>

        {showAdvanced && (
          <div className="flex flex-wrap gap-3 items-end pl-1">
            <div>
              <label className="block text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--tx-tertiary)' }}>Match type</label>
              <SimpleSelect
                value={addMatchType}
                onChange={setAddMatchType}
                options={MATCH_TYPES.map((m) => ({ value: m.value, label: m.label }))}
                width="130px"
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--tx-tertiary)' }}>Direction</label>
              <SimpleSelect
                value={addDirection}
                onChange={setAddDirection}
                options={DIRECTIONS}
                width="160px"
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--tx-tertiary)' }}>Set type</label>
              <SimpleSelect
                value={addTransactionType}
                onChange={setAddTransactionType}
                options={[
                  { value: 'none', label: 'Don\'t override' },
                  { value: 'debit', label: 'Debit' },
                  { value: 'credit', label: 'Credit' },
                  { value: 'transfer', label: 'Transfer' },
                ]}
                width="140px"
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--tx-tertiary)' }}>Min amount</label>
              <input
                type="number" step="0.01" placeholder="No min"
                value={addMinAmount}
                onChange={(e) => setAddMinAmount(e.target.value)}
                className="px-2 py-1.5 text-sm rounded-[6px] outline-none w-24"
                style={inputStyle}
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--tx-tertiary)' }}>Max amount</label>
              <input
                type="number" step="0.01" placeholder="No max"
                value={addMaxAmount}
                onChange={(e) => setAddMaxAmount(e.target.value)}
                className="px-2 py-1.5 text-sm rounded-[6px] outline-none w-24"
                style={inputStyle}
              />
            </div>
            {addMatchType === 'regex' && (
              <p className="text-[11px] self-end pb-2" style={{ color: 'var(--tx-secondary)' }}>
                Pattern is treated as a regular expression (case-insensitive).
              </p>
            )}
          </div>
        )}
      </div>

      {addError && <p className="text-xs" style={{ color: 'var(--tx-error)' }}>{addError}</p>}
    </div>
  )
}
