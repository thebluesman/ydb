'use client'

import { useState } from 'react'
import { Check, X, Pencil } from 'lucide-react'
import { pillTextColor } from '@/lib/category-colors'

type Category = { id: number; name: string; color: string }

export function CategoryManager({
  categories,
  onChange,
}: {
  categories: Category[]
  onChange: (cats: Category[]) => void
}) {
  const [newName, setNewName] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editValue, setEditValue] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<{ id: number; name: string; count: number } | null>(null)

  const handleAdd = async () => {
    const name = newName.trim()
    if (!name) { setError('Name required'); return }
    if (categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      setError('Already exists'); return
    }
    setAdding(true); setError('')
    try {
      const res = await fetch('/api/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const cat = await res.json()
      onChange([...categories, cat])
      setNewName('')
    } catch {
      setError('Failed to add')
    } finally {
      setAdding(false)
    }
  }

  const startEdit = (cat: Category) => {
    setEditingId(cat.id)
    setEditValue(cat.name)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditValue('')
  }

  const saveEdit = async (id: number) => {
    const name = editValue.trim()
    if (!name) return
    setEditSaving(true)
    try {
      const res = await fetch(`/api/categories/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) throw new Error(await res.text())
      const updated = await res.json()
      onChange(categories.map((c) => (c.id === id ? updated : c)))
      setEditingId(null)
    } catch {
      setError('Failed to rename')
    } finally {
      setEditSaving(false)
    }
  }

  const handleDelete = async (id: number, force = false) => {
    try {
      const res = await fetch(`/api/categories?id=${id}${force ? '&force=true' : ''}`, { method: 'DELETE' })
      if (res.status === 409) {
        const data = await res.json()
        const cat = categories.find((c) => c.id === id)
        setConfirmDelete({ id, name: cat?.name ?? '', count: data.count })
        return
      }
      if (!res.ok) throw new Error(await res.text())
      onChange(categories.filter((c) => c.id !== id))
      setConfirmDelete(null)
    } catch { /* silent */ }
  }

  const inputStyle = {
    border: '1px solid var(--border-warm)',
    backgroundColor: 'var(--bg-input)',
    color: 'var(--tx-primary)',
  }

  return (
    <div className="space-y-4">
      {/* Delete confirmation block */}
      {confirmDelete && (
        <div
          className="px-4 py-3 rounded-[8px] text-sm space-y-2"
          style={{ backgroundColor: 'var(--bg-notify-error)', border: '1px solid var(--border-warm)', color: 'var(--tx-notify-error)' }}
        >
          <p>
            <strong>&ldquo;{confirmDelete.name}&rdquo;</strong> is used by {confirmDelete.count} transaction{confirmDelete.count !== 1 ? 's' : ''}. Those transactions will keep the label as plain text. Delete anyway?
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => handleDelete(confirmDelete.id, true)}
              className="px-3 py-1 text-xs rounded-[6px]"
              style={{ backgroundColor: 'var(--tx-error)', color: '#fff' }}
            >
              Delete anyway
            </button>
            <button
              onClick={() => setConfirmDelete(null)}
              className="px-3 py-1 text-xs rounded-[6px]"
              style={{ backgroundColor: 'var(--bg-btn)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {categories.length === 0 && (
          <p className="text-sm" style={{ color: 'var(--tx-faint)' }}>No categories yet.</p>
        )}
        {categories.map((cat) => (
          <span
            key={cat.id}
            className="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded-full"
            style={{ backgroundColor: cat.color, color: pillTextColor(cat.color) }}
          >
            {editingId === cat.id ? (
              <>
                <input
                  type="text"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveEdit(cat.id)
                    if (e.key === 'Escape') cancelEdit()
                  }}
                  autoFocus
                  className="bg-transparent border-b outline-none w-24 text-xs"
                  style={{ borderColor: 'currentColor', opacity: 0.85, color: 'inherit' }}
                />
                <button
                  onClick={() => saveEdit(cat.id)}
                  disabled={editSaving}
                  className="text-xs leading-none transition-opacity hover:opacity-100"
                  style={{ color: 'inherit', opacity: 0.75 }}
                  title="Save"
                >
                  {editSaving ? '…' : <Check size={10} />}
                </button>
                <button
                  onClick={cancelEdit}
                  className="text-xs leading-none transition-opacity hover:opacity-100"
                  style={{ color: 'inherit', opacity: 0.6 }}
                  title="Cancel"
                >
                  <X size={10} />
                </button>
              </>
            ) : (
              <>
                {cat.name}
                <button
                  onClick={() => startEdit(cat)}
                  className="transition-opacity leading-none text-[10px] hover:opacity-100"
                  style={{ color: 'inherit', opacity: 0.6 }}
                  aria-label={`Rename ${cat.name}`}
                  title="Rename"
                >
                  <Pencil size={10} />
                </button>
                <button
                  onClick={() => handleDelete(cat.id)}
                  className="transition-opacity leading-none hover:opacity-100"
                  style={{ color: 'inherit', opacity: 0.6 }}
                  aria-label={`Remove ${cat.name}`}
                  title="Delete"
                >
                  <X size={10} />
                </button>
              </>
            )}
          </span>
        ))}
      </div>

      <div className="flex items-center gap-2 pt-4" style={{ borderTop: '1px solid var(--border-warm)' }}>
        <input
          type="text"
          placeholder="New category"
          value={newName}
          onChange={(e) => { setNewName(e.target.value); setError('') }}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          className="flex-1 px-3 py-2 text-sm rounded-[8px] outline-none transition-colors duration-150"
          style={inputStyle}
          onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--border-warm-md)')}
          onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border-warm)')}
        />
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
