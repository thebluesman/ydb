'use client'

import { useState } from 'react'
import { Plus, X } from 'lucide-react'

type SplitLeg = { amount: number; category: string; description: string }
type Category = { id: number; name: string; color: string }

export function SplitForm({
  parentId,
  parentAmount,
  parentDescription,
  parentCategory,
  categories,
  onSave,
  onCancel,
}: {
  parentId: number
  parentAmount: number
  parentDescription: string
  parentCategory: string
  categories: Category[]
  onSave: (updated: object) => void
  onCancel: () => void
}) {
  const [legs, setLegs] = useState<SplitLeg[]>([
    { amount: parentAmount, category: parentCategory, description: parentDescription },
    { amount: 0, category: categories[0]?.name ?? 'Other', description: parentDescription },
  ])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const inputStyle: React.CSSProperties = {
    border: '1px solid var(--border-warm)',
    backgroundColor: 'var(--bg-input)',
    color: 'var(--tx-primary)',
  }

  const updateLeg = (i: number, field: keyof SplitLeg, value: string | number) => {
    setLegs((prev) => prev.map((l, idx) => idx === i ? { ...l, [field]: value } : l))
    setError('')
  }

  const addLeg = () => setLegs((prev) => [...prev, { amount: 0, category: categories[0]?.name ?? 'Other', description: parentDescription }])

  const removeLeg = (i: number) => {
    if (legs.length <= 2) return
    setLegs((prev) => prev.filter((_, idx) => idx !== i))
  }

  const total = legs.reduce((s, l) => s + (Number(l.amount) || 0), 0)
  const remaining = parentAmount - total
  const isValid = Math.abs(remaining) < 0.01

  const handleSave = async () => {
    if (!isValid) { setError(`Amounts must sum to ${parentAmount.toFixed(2)}. Remaining: ${remaining.toFixed(2)}`); return }
    setSaving(true); setError('')
    try {
      const res = await fetch(`/api/transactions/${parentId}/split`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ legs: legs.map((l) => ({ ...l, amount: Number(l.amount) })) }),
      })
      if (!res.ok) throw new Error(await res.json().then((e) => e.error ?? res.statusText))
      onSave(await res.json())
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const amtColor = (amt: number) =>
    amt < 0 ? 'var(--tx-error)' : amt > 0 ? 'var(--tx-success)' : 'var(--tx-faint)'

  return (
    <>
      <tr style={{ backgroundColor: 'var(--bg-edit-row)' }}>
        <td colSpan={9} className="px-4 py-3">
          <div className="space-y-2">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs font-medium" style={{ color: 'var(--tx-secondary)' }}>
                Split transaction — amounts must sum to{' '}
                <span className="font-mono" style={{ color: amtColor(parentAmount) }}>
                  {parentAmount < 0 ? '−' : '+'}{Math.abs(parentAmount).toFixed(2)}
                </span>
              </p>
              {!isValid && (
                <span className="text-xs font-mono" style={{ color: 'var(--tx-error)' }}>
                  Remaining: {remaining > 0 ? '+' : ''}{remaining.toFixed(2)}
                </span>
              )}
            </div>

            {legs.map((leg, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="number"
                  step="0.01"
                  value={leg.amount}
                  onChange={(e) => updateLeg(i, 'amount', parseFloat(e.target.value) || 0)}
                  className="w-28 px-2 py-1 text-xs rounded-[6px] outline-none font-mono"
                  style={{ ...inputStyle, color: amtColor(Number(leg.amount)) }}
                />
                <select
                  value={leg.category}
                  onChange={(e) => updateLeg(i, 'category', e.target.value)}
                  className="px-2 py-1 text-xs rounded-[6px] outline-none"
                  style={inputStyle}
                >
                  {categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
                </select>
                <input
                  type="text"
                  value={leg.description}
                  onChange={(e) => updateLeg(i, 'description', e.target.value)}
                  className="flex-1 px-2 py-1 text-xs rounded-[6px] outline-none"
                  style={inputStyle}
                  placeholder="Description"
                />
                <button
                  onClick={() => removeLeg(i)}
                  disabled={legs.length <= 2}
                  className="disabled:opacity-20"
                  style={{ color: 'var(--tx-tertiary)' }}
                >
                  <X size={12} />
                </button>
              </div>
            ))}

            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={addLeg}
                className="flex items-center gap-1 text-xs"
                style={{ color: 'var(--tx-secondary)' }}
              >
                <Plus size={12} /> Add leg
              </button>
              <div className="ml-auto flex items-center gap-2">
                {error && <span className="text-xs" style={{ color: 'var(--tx-error)' }}>{error}</span>}
                <button
                  onClick={handleSave}
                  disabled={saving || !isValid}
                  className="px-3 py-1 text-xs rounded-[6px] font-medium disabled:opacity-40"
                  style={{ backgroundColor: 'var(--bg-btn)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}
                >
                  {saving ? '…' : 'Save Split'}
                </button>
                <button
                  onClick={onCancel}
                  className="text-xs"
                  style={{ color: 'var(--tx-secondary)' }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </td>
      </tr>
    </>
  )
}
