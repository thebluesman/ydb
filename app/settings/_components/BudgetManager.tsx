'use client'

import { useState } from 'react'
import { X, ChevronDown } from 'lucide-react'
import * as Select from '@radix-ui/react-select'
import { fromCents, toCents } from '@/lib/money'

type Budget = { id: number; category: string; monthlyLimit: number }
type Category = { id: number; name: string; color: string }

export function BudgetManager({
  initialBudgets,
  categories,
}: {
  initialBudgets: Budget[]
  categories: Category[]
}) {
  const [list, setList] = useState<Budget[]>(initialBudgets)
  const [newCategory, setNewCategory] = useState('')
  const [newLimit, setNewLimit] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')

  const inputStyle = {
    border: '1px solid var(--border-warm)',
    backgroundColor: 'var(--bg-input)',
    color: 'var(--tx-primary)',
  }

  const availableCategories = categories
    .map((c) => c.name)
    .filter((n) => !list.some((b) => b.category === n))

  const handleAdd = async () => {
    if (!newCategory) { setError('Select a category'); return }
    const limit = parseFloat(newLimit)
    if (!limit || limit <= 0) { setError('Enter a positive limit'); return }
    setAdding(true); setError('')
    try {
      const res = await fetch('/api/budgets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Server stores cents; user entered major units.
        body: JSON.stringify({ category: newCategory, monthlyLimit: toCents(limit) }),
      })
      if (!res.ok) throw new Error(await res.text())
      const budget = await res.json()
      setList((prev) => [...prev, budget].sort((a, b) => a.category.localeCompare(b.category)))
      setNewCategory(''); setNewLimit('')
    } catch {
      setError('Failed to add budget')
    } finally {
      setAdding(false)
    }
  }

  const handleDelete = async (id: number) => {
    try {
      const res = await fetch(`/api/budgets/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(await res.text())
      setList((prev) => prev.filter((b) => b.id !== id))
    } catch {
      setError('Failed to delete budget')
    }
  }

  return (
    <div className="space-y-4">
      {list.length === 0 && (
        <p className="text-sm" style={{ color: 'var(--tx-faint)' }}>No budgets set. Add one below.</p>
      )}

      {list.length > 0 && (
        <div className="rounded-[8px] overflow-hidden" style={{ border: '1px solid var(--border-warm)' }}>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-card-alt)' }}>
                <th className="px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--tx-secondary)' }}>Category</th>
                <th className="px-3 py-2 text-right text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--tx-secondary)' }}>Monthly Limit</th>
                <th className="px-3 py-2 w-12" />
              </tr>
            </thead>
            <tbody>
              {list.map((b, i) => (
                <tr key={b.id} style={{ borderTop: i > 0 ? '1px solid var(--border-warm)' : 'none' }}>
                  <td className="px-3 py-2" style={{ color: 'var(--tx-primary)' }}>{b.category}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs" style={{ color: 'var(--tx-secondary)' }}>
                    {fromCents(b.monthlyLimit).toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => handleDelete(b.id)}
                      className="transition-colors"
                      style={{ color: 'var(--tx-tertiary)' }}
                      onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--tx-error)')}
                      onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--tx-tertiary)')}
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
      <div className="flex items-end gap-2 pt-2">
        <div className="flex-1">
          <label className="block text-[11px] font-medium uppercase tracking-wide mb-1" style={{ color: 'var(--tx-secondary)' }}>
            Category
          </label>
          <Select.Root value={newCategory} onValueChange={(v) => { setNewCategory(v); setError('') }}>
            <Select.Trigger
              className="w-full flex items-center justify-between px-3 py-2 text-sm rounded-[8px] outline-none"
              style={inputStyle}
            >
              <Select.Value placeholder={<span style={{ color: 'var(--tx-faint)' }}>Select…</span>} />
              <Select.Icon style={{ color: 'var(--tx-tertiary)' }}>
                <ChevronDown size={14} />
              </Select.Icon>
            </Select.Trigger>
            <Select.Portal>
              <Select.Content
                position="popper"
                sideOffset={4}
                className="z-50 overflow-hidden rounded-[8px]"
                style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-warm)', boxShadow: 'var(--shadow-card)', minWidth: 'var(--radix-select-trigger-width)' }}
              >
                <Select.Viewport className="p-1">
                  {availableCategories.length === 0 ? (
                    <div className="px-3 py-2 text-xs" style={{ color: 'var(--tx-faint)' }}>No categories available</div>
                  ) : (
                    availableCategories.map((c) => (
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
        <div className="w-36">
          <label className="block text-[11px] font-medium uppercase tracking-wide mb-1" style={{ color: 'var(--tx-secondary)' }}>
            Monthly Limit
          </label>
          <input
            type="number"
            min="0.01"
            step="0.01"
            placeholder="e.g. 500"
            value={newLimit}
            onChange={(e) => { setNewLimit(e.target.value); setError('') }}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            className="w-full px-3 py-2 text-sm rounded-[8px] outline-none font-mono"
            style={inputStyle}
            onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--border-warm-md)')}
            onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border-warm)')}
          />
        </div>
        <button
          onClick={handleAdd}
          disabled={adding}
          className="px-3 py-2 text-sm rounded-[8px] transition-colors duration-150 disabled:opacity-40 whitespace-nowrap"
          style={{ backgroundColor: 'var(--bg-btn)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}
        >
          {adding ? '…' : 'Add'}
        </button>
      </div>

      {error && <p className="text-xs" style={{ color: 'var(--tx-error)' }}>{error}</p>}
    </div>
  )
}
