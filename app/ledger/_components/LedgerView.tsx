'use client'

import { useState, useMemo, useEffect } from 'react'
import { ArrowUpDown, ArrowUp, ArrowDown, Download, ChevronDown, AlertCircle, RotateCcw, Plus, X } from 'lucide-react'
import * as Select from '@radix-ui/react-select'
import { LedgerRow } from './LedgerRow'

type SplitLeg = { id: number; amount: number; category: string; description: string }

type Transaction = {
  id: number; date: string | Date; amount: number; description: string; originalDescription: string | null
  transactionType: string; category: string; accountId: number; status: string; notes: string | null
  linkedTransferId: number | null
  parentTransactionId: number | null
  splitLegs?: SplitLeg[]
  account: { name: string; currency: string }
  reimbursableFor: string | null
  reimbursementTxId: number | null
  reimbursementTx: { id: number; amount: number; description: string } | null
  reimbursedExpense: { id: number; description: string } | null
  transferCounterpartAccountId: number | null
  transferCounterpartAccount: { id: number; name: string } | null
}
type Account = { id: number; name: string; currency: string }
type Category = { id: number; name: string; color: string }

type SortKey = 'date' | 'amount' | 'description' | 'category' | 'transactionType'

const PAGE_SIZE = 50

function SortIcon({ col, sortKey, sortDir }: { col: string; sortKey: string; sortDir: string }) {
  if (col !== sortKey) return <ArrowUpDown size={12} className="ml-1 inline-block" style={{ color: 'var(--tx-faint)', opacity: 0.35 }} />
  return sortDir === 'asc'
    ? <ArrowUp size={12} className="ml-1 inline-block" style={{ color: 'var(--tx-secondary)' }} />
    : <ArrowDown size={12} className="ml-1 inline-block" style={{ color: 'var(--tx-secondary)' }} />
}

export function LedgerView({ initialTransactions, accounts, categories, baseCurrency }: {
  initialTransactions: Transaction[]; accounts: Account[]; categories: Category[]; baseCurrency: string
}) {
  const [transactions, setTransactions] = useState<Transaction[]>(initialTransactions)
  const [accountFilter, setAccountFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(1)

  // Add transaction form
  const [showAddForm, setShowAddForm]       = useState(false)
  const [addDate, setAddDate]               = useState(() => new Date().toISOString().split('T')[0])
  const [addDescription, setAddDescription] = useState('')
  const [addAmount, setAddAmount]           = useState('')
  const [addType, setAddType]               = useState<'debit' | 'credit' | 'transfer'>('debit')
  const [addAccountId, setAddAccountId]     = useState(() => String(accounts[0]?.id ?? ''))
  const [addCategory, setAddCategory]       = useState('')
  const [addStatus, setAddStatus]           = useState('committed')
  const [addNotes, setAddNotes]             = useState('')
  const [addSaving, setAddSaving]           = useState(false)
  const [addError, setAddError]             = useState('')

  // Bulk select state
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [bulkCategory, setBulkCategory] = useState('')
  const [bulkStatus, setBulkStatus] = useState('')
  const [bulkApplying, setBulkApplying] = useState(false)
  const [showPendingOnly, setShowPendingOnly] = useState(false)

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir('asc') }
    setPage(1)
  }

  useEffect(() => { setPage(1) }, [accountFilter, typeFilter, categoryFilter, statusFilter, search, sortKey, sortDir, showPendingOnly])

  const pendingReimbursements = useMemo(
    () => transactions.filter((t) => t.reimbursableFor && !t.reimbursementTxId && !t.parentTransactionId),
    [transactions]
  )

  const filtered = useMemo(() => transactions.filter((t) => {
    if (t.parentTransactionId !== null) return false // hide split legs from main list
    if (showPendingOnly && !(t.reimbursableFor && !t.reimbursementTxId)) return false
    if (accountFilter !== 'all' && t.accountId !== parseInt(accountFilter)) return false
    if (typeFilter !== 'all' && t.transactionType !== typeFilter) return false
    if (categoryFilter !== 'all' && t.category !== categoryFilter) return false
    if (statusFilter !== 'all' && t.status !== statusFilter) return false
    if (search) {
      const q = search.toLowerCase()
      if (!t.description.toLowerCase().includes(q) && !(t.originalDescription ?? '').toLowerCase().includes(q)) return false
    }
    return true
  }), [transactions, accountFilter, typeFilter, categoryFilter, statusFilter, search, showPendingOnly])

  const allCategories = useMemo(() => {
    const all = [...new Set([...categories.map((c) => c.name), ...transactions.map((t) => t.category).filter(Boolean)])]
    return all.sort()
  }, [transactions, categories])

  const stats = useMemo(() => {
    const nonTransfer = filtered.filter((t) => t.transactionType !== 'transfer')
    const income = nonTransfer.filter((t) => t.transactionType === 'credit').reduce((s, t) => s + t.amount, 0)
    const expenses = nonTransfer.filter((t) => t.transactionType === 'debit').reduce((s, t) => s + t.amount, 0)
    return {
      income, expenses: Math.abs(expenses), net: income - Math.abs(expenses),
      incomeCount: nonTransfer.filter((t) => t.transactionType === 'credit').length,
      expenseCount: nonTransfer.filter((t) => t.transactionType === 'debit').length,
    }
  }, [filtered])

  const currency = useMemo(() => {
    if (accountFilter !== 'all') {
      return accounts.find((a) => String(a.id) === accountFilter)?.currency ?? baseCurrency
    }
    return baseCurrency
  }, [accounts, accountFilter, baseCurrency])

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case 'date':        return dir * (new Date(a.date).getTime() - new Date(b.date).getTime())
        case 'amount':      return dir * (a.amount - b.amount)
        case 'description': return dir * a.description.localeCompare(b.description)
        case 'category':         return dir * a.category.localeCompare(b.category)
        case 'transactionType':  return dir * a.transactionType.localeCompare(b.transactionType)
      }
    })
  }, [filtered, sortKey, sortDir])

  const paginated = useMemo(
    () => sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [sorted, page]
  )

  const hasFilters = accountFilter !== 'all' || typeFilter !== 'all' || categoryFilter !== 'all' || statusFilter !== 'all' || search || showPendingOnly

  const handleUpdate = (updated: Transaction) =>
    setTransactions((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
  const handleUpdateById = (id: number, patch: Partial<Transaction>) =>
    setTransactions((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  const handleDelete = (id: number) => {
    setTransactions((prev) => prev.filter((t) => t.id !== id))
    setSelectedIds((prev) => { const n = new Set(prev); n.delete(id); return n })
  }

  // Bulk select helpers
  const pageIds = paginated.map((t) => t.id)
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id))

  const toggleSelectAll = () => {
    if (allPageSelected) {
      setSelectedIds((prev) => { const n = new Set(prev); pageIds.forEach((id) => n.delete(id)); return n })
    } else {
      setSelectedIds((prev) => { const n = new Set(prev); pageIds.forEach((id) => n.add(id)); return n })
    }
  }

  const toggleSelectRow = (id: number) => {
    setSelectedIds((prev) => {
      const n = new Set(prev)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  }

  const handleExport = () => {
    const headers = ['Date', 'Description', 'Original Description', 'Type', 'Amount', 'Category', 'Account', 'Status', 'Notes']
    const rows = sorted.map((t) => [
      new Date(t.date).toISOString().split('T')[0],
      `"${(t.description ?? '').replace(/"/g, '""')}"`,
      `"${(t.originalDescription ?? '').replace(/"/g, '""')}"`,
      t.transactionType,
      t.amount.toFixed(2),
      t.category,
      t.account.name,
      t.status,
      `"${(t.notes ?? '').replace(/"/g, '""')}"`,
    ])
    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `transactions-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleBulkApply = async () => {
    if (selectedIds.size === 0) return
    const update: Record<string, string> = {}
    if (bulkCategory) update.category = bulkCategory
    if (bulkStatus) update.status = bulkStatus
    if (Object.keys(update).length === 0) return
    setBulkApplying(true)
    try {
      const res = await fetch('/api/transactions/bulk', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selectedIds], update }),
      })
      if (!res.ok) throw new Error(await res.text())
      // Update local state
      setTransactions((prev) =>
        prev.map((t) => selectedIds.has(t.id) ? { ...t, ...update } : t)
      )
      setSelectedIds(new Set())
      setBulkCategory('')
      setBulkStatus('')
    } catch (e) {
      alert(String(e))
    } finally {
      setBulkApplying(false)
    }
  }

  const handleAddTransaction = async () => {
    const desc = addDescription.trim()
    if (!desc) { setAddError('Description required'); return }
    const amt = parseFloat(addAmount)
    if (isNaN(amt) || amt <= 0) { setAddError('Enter a positive amount'); return }
    if (!addAccountId) { setAddError('Select an account'); return }

    setAddSaving(true); setAddError('')
    try {
      const res = await fetch('/api/transactions/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: addDate,
          description: desc,
          amount: addType === 'debit' ? -amt : amt,
          transactionType: addType,
          category: addCategory || '',
          accountId: parseInt(addAccountId),
          notes: addNotes.trim() || undefined,
          status: addStatus,
        }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error ?? 'Failed to add')
      }
      const created = await res.json()
      setTransactions((prev) => [created, ...prev])
      // Reset form
      setAddDescription(''); setAddAmount(''); setAddNotes('')
      setAddDate(new Date().toISOString().split('T')[0])
      setAddCategory(''); setAddType('debit')
      setShowAddForm(false)
    } catch (e) {
      setAddError(String(e instanceof Error ? e.message : e))
    } finally {
      setAddSaving(false)
    }
  }

  const cardStyle: React.CSSProperties = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-warm)', borderRadius: '8px' }
  const selectStyle: React.CSSProperties = { border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }

  return (
    <div className="space-y-5">
      {/* Page header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[26px] font-semibold text-cursor-dark leading-[1.25]" style={{ letterSpacing: '-0.325px' }}>
            Ledger
          </h1>
          <p className="mt-1 text-sm leading-[1.5]" style={{ color: 'var(--tx-secondary)' }}>
            All transactions — filter, edit, and manage.
          </p>
        </div>
        <button
          onClick={() => { setShowAddForm((v) => !v); setAddError('') }}
          className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-[8px] transition-colors duration-150"
          style={{ backgroundColor: showAddForm ? 'var(--bg-card-alt)' : 'var(--bg-btn)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}
        >
          <Plus size={14} />
          Add
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Income',   value: `+${currency} ${stats.income.toFixed(2)}`,   sub: `${stats.incomeCount} transaction${stats.incomeCount !== 1 ? 's' : ''}`,   bg: 'var(--bg-stat-income)',  tx: 'var(--tx-stat-income)' },
          { label: 'Expenses', value: `−${currency} ${stats.expenses.toFixed(2)}`, sub: `${stats.expenseCount} transaction${stats.expenseCount !== 1 ? 's' : ''}`, bg: 'var(--bg-stat-expense)', tx: 'var(--tx-stat-expense)' },
          { label: 'Net',      value: `${stats.net >= 0 ? '+' : '−'}${currency} ${Math.abs(stats.net).toFixed(2)}`, sub: `${filtered.length} shown`, bg: 'var(--bg-stat-net)', tx: stats.net >= 0 ? 'var(--tx-stat-net-pos)' : 'var(--tx-stat-net-neg)' },
        ].map(({ label, value, sub, bg, tx }) => (
          <div key={label} className="card-hover p-5 rounded-[8px]" style={{ backgroundColor: bg, border: '1px solid var(--border-warm)' }}>
            <p className="text-[11px] font-medium uppercase tracking-[0.048px] mb-2" style={{ color: 'var(--tx-secondary)' }}>{label}</p>
            <p className="text-xl font-semibold font-mono" style={{ color: tx, letterSpacing: '-0.5px' }}>{value}</p>
            <p className="text-xs mt-1" style={{ color: 'var(--tx-faint)' }}>{sub}</p>
          </div>
        ))}
      </div>

      {/* Pending reimbursements banner */}
      {pendingReimbursements.length > 0 && (
        <button
          onClick={() => setShowPendingOnly((v) => !v)}
          className="w-full flex items-center gap-2.5 px-4 py-3 rounded-[8px] text-sm text-left transition-colors duration-150"
          style={{
            backgroundColor: showPendingOnly ? 'var(--bg-badge-review)' : 'var(--bg-card)',
            border: '1px solid var(--border-warm)',
            color: 'var(--tx-badge-review)',
          }}
        >
          <RotateCcw size={14} style={{ flexShrink: 0 }} />
          <span>
            {pendingReimbursements.length} pending reimbursement{pendingReimbursements.length !== 1 ? 's' : ''} awaiting settlement
            {' — '}
            {currency}{pendingReimbursements.reduce((s, t) => s + Math.abs(t.amount), 0).toFixed(2)} outstanding
          </span>
          <span className="ml-auto text-xs" style={{ color: 'var(--tx-secondary)' }}>
            {showPendingOnly ? 'Show all' : 'Filter'}
          </span>
        </button>
      )}

      {/* Filters */}
      <div className="p-4" style={cardStyle}>
        <div className="flex flex-wrap gap-3 items-center">
          <input type="search" placeholder="Search descriptions…" value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 min-w-[200px] px-3 py-2 text-sm rounded-[8px] outline-none transition-colors duration-150"
            style={selectStyle}
            onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--border-warm-md)')}
            onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border-warm)')}
          />
          {[
            { value: accountFilter, onChange: setAccountFilter, options: [{ value: 'all', label: 'All accounts' }, ...accounts.map((a) => ({ value: String(a.id), label: a.name }))] },
            { value: typeFilter,    onChange: setTypeFilter,    options: [{ value: 'all', label: 'All types' }, { value: 'debit', label: 'Debit' }, { value: 'credit', label: 'Credit' }, { value: 'transfer', label: 'Transfer' }] },
            { value: statusFilter,  onChange: setStatusFilter,  options: [{ value: 'all', label: 'All statuses' }, { value: 'committed', label: 'Committed' }, { value: 'reconciled', label: 'Reconciled' }, { value: 'review', label: 'Review' }] },
          ].map(({ value, onChange, options }, i) => (
            <FilterSelect key={i} value={value} onChange={onChange} options={options} />
          ))}
          {/* Category filter — with empty state when no user categories exist */}
          <Select.Root value={categoryFilter} onValueChange={setCategoryFilter}>
            <Select.Trigger
              className="flex items-center gap-2 px-3 py-2 text-sm rounded-[8px] outline-none"
              style={selectStyle}
            >
              <Select.Value />
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
                  <Select.Item
                    value="all"
                    className="px-3 py-2 text-sm rounded-[6px] cursor-pointer outline-none select-none transition-colors duration-100"
                    style={{ color: 'var(--tx-primary)' }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-card-alt)')}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                  >
                    <Select.ItemText>All categories</Select.ItemText>
                  </Select.Item>
                  {categories.length === 0 && (
                    <div className="flex items-center gap-1.5 px-3 py-1.5">
                      <AlertCircle size={11} strokeWidth={1.5} style={{ color: 'var(--tx-tertiary)' }} />
                      <span className="text-[11px]" style={{ color: 'var(--tx-tertiary)' }}>No custom categories yet</span>
                    </div>
                  )}
                  {allCategories.map((c) => (
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
                  ))}
                </Select.Viewport>
              </Select.Content>
            </Select.Portal>
          </Select.Root>
          {hasFilters && (
            <button onClick={() => { setAccountFilter('all'); setTypeFilter('all'); setCategoryFilter('all'); setStatusFilter('all'); setSearch(''); setShowPendingOnly(false) }}
              className="text-sm transition-colors duration-150 hover:text-error" style={{ color: 'var(--tx-secondary)' }}>
              Clear
            </button>
          )}
          <button
            onClick={handleExport}
            disabled={sorted.length === 0}
            className="flex items-center gap-1.5 text-sm transition-colors duration-150 disabled:opacity-30 ml-auto"
            style={{ color: 'var(--tx-secondary)' }}
            title="Export filtered view as CSV"
          >
            <Download size={14} />
            Export
          </button>
        </div>
      </div>

      {/* Add transaction form */}
      {showAddForm && (
        <div className="p-4 rounded-[8px] space-y-3" style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-warm)' }}>
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium" style={{ color: 'var(--tx-primary)' }}>New transaction</span>
            <button onClick={() => { setShowAddForm(false); setAddError('') }} style={{ color: 'var(--tx-tertiary)' }}>
              <X size={15} />
            </button>
          </div>
          <div className="flex flex-wrap gap-3 items-end">
            <div>
              <label className="block text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--tx-tertiary)' }}>Date</label>
              <input
                type="date" value={addDate} onChange={(e) => setAddDate(e.target.value)}
                className="px-2 py-1.5 text-sm rounded-[6px] outline-none"
                style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }}
              />
            </div>
            <div className="flex-1 min-w-[180px]">
              <label className="block text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--tx-tertiary)' }}>Description</label>
              <input
                type="text" value={addDescription} onChange={(e) => { setAddDescription(e.target.value); setAddError('') }}
                onKeyDown={(e) => e.key === 'Enter' && handleAddTransaction()}
                placeholder="e.g. Coffee"
                className="w-full px-2 py-1.5 text-sm rounded-[6px] outline-none"
                style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }}
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--tx-tertiary)' }}>Type</label>
              <div className="flex rounded-[6px] overflow-hidden" style={{ border: '1px solid var(--border-warm)' }}>
                {(['debit', 'credit', 'transfer'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setAddType(t)}
                    className="px-2.5 py-1.5 text-xs capitalize"
                    style={{
                      backgroundColor: addType === t
                        ? t === 'debit' ? 'var(--bg-stat-expense)' : t === 'credit' ? 'var(--bg-stat-income)' : 'rgba(245,158,11,0.15)'
                        : 'var(--bg-input)',
                      color: addType === t
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
            <div>
              <label className="block text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--tx-tertiary)' }}>Amount</label>
              <input
                type="number" min="0" step="0.01" value={addAmount}
                onChange={(e) => { setAddAmount(e.target.value); setAddError('') }}
                onKeyDown={(e) => e.key === 'Enter' && handleAddTransaction()}
                placeholder="0.00"
                className="w-24 px-2 py-1.5 text-sm rounded-[6px] outline-none font-mono"
                style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }}
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--tx-tertiary)' }}>Account</label>
              <select
                value={addAccountId} onChange={(e) => setAddAccountId(e.target.value)}
                className="px-2 py-1.5 text-sm rounded-[6px] outline-none"
                style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }}
              >
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--tx-tertiary)' }}>Category</label>
              <select
                value={addCategory} onChange={(e) => setAddCategory(e.target.value)}
                className="px-2 py-1.5 text-sm rounded-[6px] outline-none"
                style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }}
              >
                <option value="">Other</option>
                {allCategories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--tx-tertiary)' }}>Status</label>
              <select
                value={addStatus} onChange={(e) => setAddStatus(e.target.value)}
                className="px-2 py-1.5 text-sm rounded-[6px] outline-none"
                style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }}
              >
                <option value="committed">Committed</option>
                <option value="review">Review</option>
                <option value="reconciled">Reconciled</option>
              </select>
            </div>
            <div className="flex-1 min-w-[140px]">
              <label className="block text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--tx-tertiary)' }}>Notes</label>
              <input
                type="text" value={addNotes} onChange={(e) => setAddNotes(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddTransaction()}
                placeholder="Optional"
                className="w-full px-2 py-1.5 text-sm rounded-[6px] outline-none"
                style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }}
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleAddTransaction} disabled={addSaving}
              className="px-4 py-1.5 text-sm rounded-[6px] font-medium disabled:opacity-40"
              style={{ backgroundColor: 'var(--bg-btn)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}
            >
              {addSaving ? '…' : 'Save'}
            </button>
            {addError && <span className="text-xs" style={{ color: 'var(--tx-error)' }}>{addError}</span>}
          </div>
        </div>
      )}

      {/* Table */}
      <div className="overflow-hidden rounded-[8px]" style={{ border: '1px solid var(--border-warm)' }}>
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3" style={{ color: 'var(--tx-tertiary)', backgroundColor: 'var(--bg-card)' }}>
            <span className="text-3xl opacity-30">—</span>
            <p className="text-sm">
              {transactions.length === 0 ? 'No transactions yet. Upload a statement to get started.' : 'No transactions match the current filters.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead style={{ backgroundColor: 'var(--bg-table-head)' }}>
                <tr>
                  <th className="px-3 py-3 w-10">
                    <input
                      type="checkbox"
                      checked={allPageSelected}
                      onChange={toggleSelectAll}
                      className="cursor-pointer"
                      title="Select all on this page"
                    />
                  </th>
                  {([
                    { key: 'date',        label: 'Date',        sortable: true  },
                    { key: 'description', label: 'Description', sortable: true  },
                    { key: 'amount',      label: 'Amount',      sortable: true  },
                    { key: 'category',    label: 'Category',    sortable: true  },
                    { key: 'account',     label: 'Account',     sortable: false },
                    { key: 'status',      label: 'Status',      sortable: false },
                    { key: 'actions',     label: '',            sortable: false },
                  ] as const).map(({ key, label, sortable }) =>
                    sortable ? (
                      <th key={key}
                        className="px-3 py-3 text-left text-xs font-medium whitespace-nowrap cursor-pointer select-none"
                        style={{ color: 'var(--tx-secondary)' }}
                        onClick={() => toggleSort(key as SortKey)}>
                        {label}
                        <SortIcon col={key} sortKey={sortKey} sortDir={sortDir} />
                      </th>
                    ) : (
                      <th key={key}
                        className="px-3 py-3 text-left text-xs font-medium whitespace-nowrap"
                        style={{ color: 'var(--tx-secondary)' }}>
                        {label}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody style={{ backgroundColor: 'var(--bg-card)' }}>
                {paginated.map((t) => (
                  <LedgerRow
                    key={t.id}
                    transaction={t}
                    accounts={accounts}
                    categories={categories}
                    onUpdate={handleUpdate}
                    onUpdateById={handleUpdateById}
                    onDelete={handleDelete}
                    selected={selectedIds.has(t.id)}
                    onToggleSelect={() => toggleSelectRow(t.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {sorted.length > PAGE_SIZE && (
        <div className="flex items-center justify-between px-3 py-2 rounded-[8px] text-xs"
          style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-warm)', color: 'var(--tx-secondary)' }}>
          <span>
            Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, sorted.length)} of {sorted.length}
          </span>
          <div className="flex gap-2">
            <button
              disabled={page === 1}
              onClick={() => setPage((p) => p - 1)}
              className="px-3 py-1 rounded-[6px] transition-colors duration-150 disabled:opacity-30"
              style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-btn)', color: 'var(--tx-primary)' }}>
              Prev
            </button>
            <button
              disabled={page * PAGE_SIZE >= sorted.length}
              onClick={() => setPage((p) => p + 1)}
              className="px-3 py-1 rounded-[6px] transition-colors duration-150 disabled:opacity-30"
              style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-btn)', color: 'var(--tx-primary)' }}>
              Next
            </button>
          </div>
        </div>
      )}

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 50,
            backgroundColor: 'var(--bg-card)',
            border: '1px solid var(--border-warm-md)',
            borderRadius: '12px',
            boxShadow: 'var(--shadow-card)',
            padding: '10px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            whiteSpace: 'nowrap',
          }}
        >
          <span className="text-sm font-medium" style={{ color: 'var(--tx-primary)' }}>
            {selectedIds.size} selected
          </span>
          <select
            value={bulkCategory}
            onChange={(e) => setBulkCategory(e.target.value)}
            className="px-2 py-1 text-xs rounded-[6px] outline-none"
            style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }}
          >
            <option value="">Category…</option>
            {allCategories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select
            value={bulkStatus}
            onChange={(e) => setBulkStatus(e.target.value)}
            className="px-2 py-1 text-xs rounded-[6px] outline-none"
            style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }}
          >
            <option value="">Status…</option>
            <option value="review">Review</option>
            <option value="committed">Committed</option>
            <option value="reconciled">Reconciled</option>
          </select>
          <button
            onClick={handleBulkApply}
            disabled={bulkApplying || (!bulkCategory && !bulkStatus)}
            className="px-3 py-1 text-xs rounded-[6px] font-medium transition-colors duration-150 disabled:opacity-40"
            style={{ backgroundColor: 'var(--bg-selected)', color: 'var(--tx-selected)', border: '1px solid var(--border-warm)' }}
          >
            {bulkApplying ? '…' : 'Apply'}
          </button>
          <button
            onClick={() => { setSelectedIds(new Set()); setBulkCategory(''); setBulkStatus('') }}
            className="text-xs transition-colors duration-150"
            style={{ color: 'var(--tx-secondary)' }}
          >
            Clear
          </button>
        </div>
      )}
    </div>
  )
}

function FilterSelect({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  const selectStyle: React.CSSProperties = { border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }
  return (
    <Select.Root value={value} onValueChange={onChange}>
      <Select.Trigger
        className="flex items-center gap-2 px-3 py-2 text-sm rounded-[8px] outline-none"
        style={selectStyle}
      >
        <Select.Value />
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
            {options.map((o) => (
              <Select.Item
                key={o.value}
                value={o.value}
                className="px-3 py-2 text-sm rounded-[6px] cursor-pointer outline-none select-none transition-colors duration-100"
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
