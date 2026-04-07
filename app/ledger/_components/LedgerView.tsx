'use client'

import { useState, useMemo, useEffect } from 'react'
import { ArrowUpDown, ArrowUp, ArrowDown, Download, ChevronDown, AlertCircle } from 'lucide-react'
import * as Select from '@radix-ui/react-select'
import { LedgerRow } from './LedgerRow'

type SplitLeg = { id: number; amount: number; category: string; description: string }

type Transaction = {
  id: number; date: string | Date; amount: number; description: string
  category: string; accountId: number; status: string; notes: string | null
  linkedTransferId: number | null
  parentTransactionId: number | null
  splitLegs?: SplitLeg[]
  account: { name: string; currency: string }
}
type Account = { id: number; name: string; currency: string }
type Category = { id: number; name: string; color: string }

type SortKey = 'date' | 'amount' | 'description' | 'category'

const PAGE_SIZE = 50

function SortIcon({ col, sortKey, sortDir }: { col: string; sortKey: string; sortDir: string }) {
  if (col !== sortKey) return <ArrowUpDown size={12} className="ml-1 inline-block" style={{ color: 'var(--tx-faint)', opacity: 0.35 }} />
  return sortDir === 'asc'
    ? <ArrowUp size={12} className="ml-1 inline-block" style={{ color: 'var(--tx-secondary)' }} />
    : <ArrowDown size={12} className="ml-1 inline-block" style={{ color: 'var(--tx-secondary)' }} />
}

export function LedgerView({ initialTransactions, accounts, categories }: {
  initialTransactions: Transaction[]; accounts: Account[]; categories: Category[]
}) {
  const [transactions, setTransactions] = useState<Transaction[]>(initialTransactions)
  const [accountFilter, setAccountFilter] = useState('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(1)

  // Bulk select state
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [bulkCategory, setBulkCategory] = useState('')
  const [bulkStatus, setBulkStatus] = useState('')
  const [bulkApplying, setBulkApplying] = useState(false)

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir('asc') }
    setPage(1)
  }

  useEffect(() => { setPage(1) }, [accountFilter, categoryFilter, statusFilter, search, sortKey, sortDir])

  const filtered = useMemo(() => transactions.filter((t) => {
    if (t.parentTransactionId !== null) return false // hide split legs from main list
    if (accountFilter !== 'all' && t.accountId !== parseInt(accountFilter)) return false
    if (categoryFilter !== 'all' && t.category !== categoryFilter) return false
    if (statusFilter !== 'all' && t.status !== statusFilter) return false
    if (search && !t.description.toLowerCase().includes(search.toLowerCase())) return false
    return true
  }), [transactions, accountFilter, categoryFilter, statusFilter, search])

  const allCategories = useMemo(() => {
    const all = [...new Set([...categories.map((c) => c.name), 'Transfer', 'Income', 'Other', ...transactions.map((t) => t.category)])]
    return all.sort()
  }, [transactions, categories])

  const stats = useMemo(() => {
    const nonTransfer = filtered.filter((t) => t.category !== 'Transfer')
    const income = nonTransfer.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0)
    const expenses = nonTransfer.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0)
    return {
      income, expenses, net: income + expenses,
      incomeCount: nonTransfer.filter((t) => t.amount > 0).length,
      expenseCount: nonTransfer.filter((t) => t.amount < 0).length,
    }
  }, [filtered])

  const currency = useMemo(() => {
    if (accountFilter !== 'all') {
      return accounts.find((a) => String(a.id) === accountFilter)?.currency ?? 'GBP'
    }
    return accounts[0]?.currency ?? 'GBP'
  }, [accounts, accountFilter])

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case 'date':        return dir * (new Date(a.date).getTime() - new Date(b.date).getTime())
        case 'amount':      return dir * (a.amount - b.amount)
        case 'description': return dir * a.description.localeCompare(b.description)
        case 'category':    return dir * a.category.localeCompare(b.category)
      }
    })
  }, [filtered, sortKey, sortDir])

  const paginated = useMemo(
    () => sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [sorted, page]
  )

  const hasFilters = accountFilter !== 'all' || categoryFilter !== 'all' || statusFilter !== 'all' || search

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
    const headers = ['Date', 'Description', 'Amount', 'Category', 'Account', 'Status', 'Notes']
    const rows = sorted.map((t) => [
      new Date(t.date).toISOString().split('T')[0],
      `"${(t.description ?? '').replace(/"/g, '""')}"`,
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

  const cardStyle: React.CSSProperties = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-warm)', borderRadius: '8px' }
  const selectStyle: React.CSSProperties = { border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }

  return (
    <div className="space-y-5">
      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Income',   value: `+${currency} ${stats.income.toFixed(2)}`,             sub: `${stats.incomeCount} transaction${stats.incomeCount !== 1 ? 's' : ''}`, bg: 'var(--bg-stat-income)',  tx: 'var(--tx-stat-income)' },
          { label: 'Expenses', value: `−${currency} ${Math.abs(stats.expenses).toFixed(2)}`, sub: `${stats.expenseCount} transaction${stats.expenseCount !== 1 ? 's' : ''}`, bg: 'var(--bg-stat-expense)', tx: 'var(--tx-stat-expense)' },
          { label: 'Net',      value: `${stats.net >= 0 ? '+' : '−'}${currency} ${Math.abs(stats.net).toFixed(2)}`, sub: `${filtered.length} shown`, bg: 'var(--bg-stat-net)', tx: stats.net >= 0 ? 'var(--tx-stat-net-pos)' : 'var(--tx-stat-net-neg)' },
        ].map(({ label, value, sub, bg, tx }) => (
          <div key={label} className="card-hover p-5 rounded-[8px]" style={{ backgroundColor: bg, border: '1px solid var(--border-warm)' }}>
            <p className="text-[11px] font-medium uppercase tracking-[0.048px] mb-2" style={{ color: 'var(--tx-secondary)' }}>{label}</p>
            <p className="text-xl font-semibold font-mono" style={{ color: tx, letterSpacing: '-0.5px' }}>{value}</p>
            <p className="text-xs mt-1" style={{ color: 'var(--tx-faint)' }}>{sub}</p>
          </div>
        ))}
      </div>

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
            <button onClick={() => { setAccountFilter('all'); setCategoryFilter('all'); setStatusFilter('all'); setSearch('') }}
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
                  <th className="px-3 py-2.5 w-8">
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
                    { key: 'notes',       label: 'Notes',       sortable: false },
                    { key: 'actions',     label: '',            sortable: false },
                  ] as const).map(({ key, label, sortable }) =>
                    sortable ? (
                      <th key={key}
                        className="px-3 py-2.5 text-left text-xs font-medium whitespace-nowrap cursor-pointer select-none"
                        style={{ color: 'var(--tx-secondary)' }}
                        onClick={() => toggleSort(key as SortKey)}>
                        {label}
                        <SortIcon col={key} sortKey={sortKey} sortDir={sortDir} />
                      </th>
                    ) : (
                      <th key={key}
                        className="px-3 py-2.5 text-left text-xs font-medium whitespace-nowrap"
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
