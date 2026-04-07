'use client'

import { useState } from 'react'
import * as Select from '@radix-ui/react-select'
import { AlertCircle, ChevronDown, X } from 'lucide-react'
import { pillTextColor } from '@/lib/category-colors'

type VendorRule = { id: number; pattern: string; vendor: string; category: string }
type Category = { id: number; name: string; color: string }

export function VendorRuleManager({
  rules,
  categories,
}: {
  rules: VendorRule[]
  categories: Category[]
}) {
  const [list, setList] = useState<VendorRule[]>(rules)
  const [vendor, setVendor] = useState('')
  const [pattern, setPattern] = useState('')
  const [category, setCategory] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editCategory, setEditCategory] = useState('')
  const [editSaving, setEditSaving] = useState(false)

  const allCategories = [...new Set([...categories.map((c) => c.name), 'Transfer', 'Income', 'Other'])]

  const inputStyle = {
    border: '1px solid var(--border-warm)',
    backgroundColor: 'var(--bg-input)',
    color: 'var(--tx-primary)',
  }

  const handleAdd = async () => {
    const v = vendor.trim()
    const p = pattern.trim()
    if (!v) { setError('Vendor name required'); return }
    if (!p) { setError('Pattern required'); return }
    if (!category) { setError('Category required'); return }
    if (list.some((r) => r.pattern.toLowerCase() === p.toLowerCase())) {
      setError('Pattern already exists'); return
    }
    setAdding(true); setError('')
    try {
      const res = await fetch('/api/vendor-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vendor: v, pattern: p, category }),
      })
      if (!res.ok) throw new Error(await res.text())
      const rule = await res.json()
      setList((prev) => [...prev, rule].sort((a, b) => a.vendor.localeCompare(b.vendor)))
      setVendor(''); setPattern('')
    } catch {
      setError('Failed to add rule')
    } finally {
      setAdding(false)
    }
  }

  const startEdit = (rule: VendorRule) => {
    setEditingId(rule.id)
    setEditCategory(rule.category)
  }

  const saveEdit = async (rule: VendorRule) => {
    setEditSaving(true)
    try {
      const res = await fetch('/api/vendor-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern: rule.pattern, vendor: rule.vendor, category: editCategory }),
      })
      if (!res.ok) throw new Error(await res.text())
      const updated = await res.json()
      setList((prev) => prev.map((r) => (r.id === rule.id ? updated : r)))
      setEditingId(null)
    } catch {
      setError('Failed to update')
    } finally {
      setEditSaving(false)
    }
  }

  const handleDelete = async (id: number) => {
    try {
      const res = await fetch(`/api/vendor-rules?id=${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(await res.text())
      setList((prev) => prev.filter((r) => r.id !== id))
    } catch {
      setError('Failed to delete')
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs" style={{ color: 'var(--tx-secondary)' }}>
        When Qwen sees a description containing a pattern (case-insensitive), it will use the mapped category. Explicit rules override learned patterns.
      </p>

      {list.length === 0 && (
        <p className="text-sm" style={{ color: 'var(--tx-faint)' }}>No rules yet.</p>
      )}

      {list.length > 0 && (
        <div className="rounded-[8px] overflow-hidden" style={{ border: '1px solid var(--border-warm)' }}>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-card-alt)' }}>
                <th className="px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--tx-secondary)' }}>Vendor</th>
                <th className="px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--tx-secondary)' }}>Pattern</th>
                <th className="px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--tx-secondary)' }}>Category</th>
                <th className="px-3 py-2 w-16" />
              </tr>
            </thead>
            <tbody>
              {list.map((rule, i) => (
                <tr
                  key={rule.id}
                  style={{ borderTop: i > 0 ? '1px solid var(--border-warm)' : 'none' }}
                >
                  <td className="px-3 py-2" style={{ color: 'var(--tx-primary)' }}>{rule.vendor}</td>
                  <td className="px-3 py-2 font-mono text-xs" style={{ color: 'var(--tx-secondary)' }}>{rule.pattern}</td>
                  <td className="px-3 py-2">
                    {editingId === rule.id ? (
                      <div className="flex items-center gap-2">
                        <Select.Root value={editCategory} onValueChange={setEditCategory}>
                          <Select.Trigger
                            className="flex items-center gap-1.5 px-2 py-1 text-xs rounded-[6px] outline-none"
                            style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }}
                          >
                            <Select.Value />
                            <Select.Icon style={{ color: 'var(--tx-tertiary)' }}>
                              <ChevronDown size={12} />
                            </Select.Icon>
                          </Select.Trigger>
                          <Select.Portal>
                            <Select.Content
                              className="rounded-[8px] z-50 overflow-hidden"
                              style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-warm)', boxShadow: 'var(--shadow-card)' }}
                            >
                              <Select.Viewport className="p-1">
                                {allCategories.map((c) => (
                                  <Select.Item
                                    key={c}
                                    value={c}
                                    className="px-3 py-1.5 text-xs rounded-[6px] cursor-pointer outline-none select-none transition-colors duration-100"
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
                        <button
                          onClick={() => saveEdit(rule)}
                          disabled={editSaving}
                          className="text-xs px-2 py-1 rounded-[6px]"
                          style={{ backgroundColor: 'var(--bg-btn)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}
                        >
                          {editSaving ? '…' : 'Save'}
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="text-xs"
                          style={{ color: 'var(--tx-tertiary)' }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => startEdit(rule)}
                        className="text-xs px-2 py-0.5 rounded-full font-medium text-white transition-opacity hover:opacity-80"
                        style={{
                          backgroundColor: categories.find((c) => c.name === rule.category)?.color ?? '#6750A4',
                          color: pillTextColor(categories.find((c) => c.name === rule.category)?.color ?? '#6750A4'),
                        }}
                        title="Click to edit"
                      >
                        {rule.category}
                      </button>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => handleDelete(rule.id)}
                      className="text-xs transition-colors"
                      style={{ color: 'var(--tx-tertiary)' }}
                      onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--tx-error)')}
                      onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--tx-tertiary)')}
                      title="Delete rule"
                    >
                      <X size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add row */}
      <div
        className="flex items-end gap-2 pt-4"
        style={{ borderTop: list.length > 0 ? '1px solid var(--border-warm)' : 'none' }}
      >
        <div className="flex-1">
          <label className="block text-[11px] font-medium uppercase tracking-wide mb-1" style={{ color: 'var(--tx-secondary)' }}>
            Vendor Name
          </label>
          <input
            type="text"
            placeholder="e.g. Netflix"
            value={vendor}
            onChange={(e) => { setVendor(e.target.value); setError('') }}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            className="w-full px-3 py-2 text-sm rounded-[8px] outline-none transition-colors duration-150"
            style={inputStyle}
            onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--border-warm-md)')}
            onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border-warm)')}
          />
        </div>
        <div className="flex-1">
          <label className="block text-[11px] font-medium uppercase tracking-wide mb-1" style={{ color: 'var(--tx-secondary)' }}>
            Pattern (substring)
          </label>
          <input
            type="text"
            placeholder="e.g. NETFLIX.COM"
            value={pattern}
            onChange={(e) => { setPattern(e.target.value); setError('') }}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            className="w-full px-3 py-2 text-sm rounded-[8px] outline-none font-mono transition-colors duration-150"
            style={inputStyle}
            onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--border-warm-md)')}
            onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border-warm)')}
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium uppercase tracking-wide mb-1" style={{ color: 'var(--tx-secondary)' }}>
            Category
          </label>
          <Select.Root value={category} onValueChange={setCategory}>
            <Select.Trigger
              className="flex items-center gap-2 px-3 py-2 text-sm rounded-[8px] outline-none min-w-[120px]"
              style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }}
            >
              <Select.Value placeholder={<span style={{ color: 'var(--tx-faint)' }}>e.g. Groceries</span>} />
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
                    <div className="flex flex-col items-center justify-center gap-1.5 px-4 py-4 text-center">
                      <AlertCircle size={16} strokeWidth={1.5} style={{ color: 'var(--tx-tertiary)' }} />
                      <span className="text-xs" style={{ color: 'var(--tx-tertiary)' }}>No categories created yet</span>
                    </div>
                  ) : (
                    allCategories.map((c) => (
                      <Select.Item
                        key={c}
                        value={c}
                        className="px-3 py-2 text-sm rounded-[6px] cursor-pointer outline-none select-none transition-colors duration-100"
                        style={{ color: 'var(--tx-primary)' }}
                        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-card-alt)')}
                        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                      >
                        <Select.ItemText>{c}</Select.ItemText>
                      </Select.Item>
                    ))
                  )}
                </Select.Viewport>
              </Select.Content>
            </Select.Portal>
          </Select.Root>
        </div>
        <button
          onClick={handleAdd}
          disabled={adding}
          className="px-[12px] py-[7px] text-sm rounded-[8px] transition-colors duration-150 hover:text-error disabled:opacity-40 whitespace-nowrap"
          style={{ backgroundColor: 'var(--bg-btn)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}
        >
          {adding ? '…' : 'Add'}
        </button>
      </div>

      {error && <p className="text-xs" style={{ color: 'var(--tx-error)' }}>{error}</p>}
    </div>
  )
}
