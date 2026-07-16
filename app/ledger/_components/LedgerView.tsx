'use client'

import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { ArrowUpDown, ArrowUp, ArrowDown, Download, ChevronDown, AlertCircle, RotateCcw, Plus, X } from 'lucide-react'
import * as RSelect from '@radix-ui/react-select'
import { LedgerRow } from './LedgerRow'
import { DatePicker } from '@/app/_components/DatePicker'
import { Select, Card, Button, useToast } from '@/app/_components/ui'
import { fromCents, toCents } from '@/lib/money'
import { DEFAULT_PAGE_SIZE, SORT_KEYS, type SortKey } from '@/lib/transactions-query'

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

type LedgerStats = {
  income: number; expenses: number; net: number
  incomeCount: number; expenseCount: number
  currency: string
  pendingReimbursementCount: number
  pendingReimbursementOutstanding: number
}

const PAGE_SIZE = DEFAULT_PAGE_SIZE

function SortIcon({ col, sortKey, sortDir }: { col: string; sortKey: string; sortDir: string }) {
  if (col !== sortKey) return <ArrowUpDown size={12} className="ml-1 inline-block" style={{ color: 'var(--tx-faint)', opacity: 0.35 }} />
  return sortDir === 'asc'
    ? <ArrowUp size={12} className="ml-1 inline-block" style={{ color: 'var(--tx-secondary)' }} />
    : <ArrowDown size={12} className="ml-1 inline-block" style={{ color: 'var(--tx-secondary)' }} />
}

export function LedgerView({ initialRows, initialTotal, initialStats, accounts, categories, categoryOptions }: {
  initialRows: Transaction[]
  initialTotal: number
  initialStats: LedgerStats
  accounts: Account[]
  categories: Category[]
  // Distinct categories across the whole table (all pages), from the server —
  // so the filter dropdown isn't limited to the current page's rows.
  categoryOptions: string[]
}) {
  const toast = useToast()
  const router = useRouter()
  const pathname = usePathname() ?? '/ledger'
  // useSearchParams() is typed nullable (null during certain prerender paths);
  // coerce once so the reads below stay clean. All uses here are read-only.
  // useMemo keeps the reference stable for the callbacks that depend on it.
  const rawSearchParams = useSearchParams()
  const searchParams = useMemo(() => rawSearchParams ?? new URLSearchParams(), [rawSearchParams])
  const paramsKey = searchParams.toString()

  // Server-driven data. Seeded from the SSR render; refetched on any URL change.
  const [rows, setRows] = useState<Transaction[]>(initialRows)
  const [total, setTotal] = useState(initialTotal)
  const [stats, setStats] = useState<LedgerStats>(initialStats)
  const [loading, setLoading] = useState(false)

  // Filters are read from the URL (the single source of truth); the search box
  // keeps a local value so typing feels instant and debounces into the URL.
  const accountFilter = searchParams.get('accountId') ?? 'all'
  const typeFilter = searchParams.get('type') ?? 'all'
  const categoryFilter = searchParams.get('category') ?? 'all'
  const statusFilter = searchParams.get('status') ?? 'all'
  const urlSearch = searchParams.get('search') ?? ''
  const sortKey = (SORT_KEYS as readonly string[]).includes(searchParams.get('sort') ?? '')
    ? (searchParams.get('sort') as SortKey)
    : 'date'
  const sortDir = searchParams.get('dir') === 'asc' ? 'asc' : 'desc'
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1)
  const showPendingOnly = searchParams.get('pendingReimbursements') === '1'

  const [searchInput, setSearchInput] = useState(urlSearch)

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
  const [addTransferDirection, setAddTransferDirection] = useState<'in' | 'out'>('out')
  const [addCounterpartId, setAddCounterpartId] = useState<string>('')
  const [addSaving, setAddSaving]           = useState(false)
  const [addError, setAddError]             = useState('')

  // Bulk select state
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [bulkCategory, setBulkCategory] = useState('')
  const [bulkStatus, setBulkStatus] = useState('')
  const [bulkApplying, setBulkApplying] = useState(false)

  const currency = stats.currency
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // On "All accounts" with more than one currency, the row list spans every
  // account (all currencies), but the stat cards can only sum a single currency
  // — so they're scoped to the base currency and labelled as such. Surface that
  // difference instead of silently hiding it (and instead of the old behaviour,
  // which narrowed the rows to base-currency accounts and could render empty).
  const isMultiCurrency = useMemo(() => new Set(accounts.map((a) => a.currency)).size > 1, [accounts])
  const showCurrencyNote = accountFilter === 'all' && isMultiCurrency

  // ── URL helpers ────────────────────────────────────────────────────────────
  const updateParams = useCallback(
    (patch: Record<string, string | null>, opts: { resetPage?: boolean } = {}) => {
      const next = new URLSearchParams(searchParams.toString())
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === '' || v === 'all') next.delete(k)
        else next.set(k, v)
      }
      if (opts.resetPage !== false && !('page' in patch)) next.delete('page')
      const qs = next.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [router, pathname, searchParams],
  )

  // ── Fetch on URL change (skip the first render — SSR already matched it) ─────
  const firstRender = useRef(true)
  const refetch = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/transactions?${searchParams.toString()}`)
      if (!res.ok) throw new Error(await res.text())
      const data = await res.json()
      setRows(data.rows)
      setTotal(data.total)
      setStats(data.stats)
    } catch {
      /* leave the last good page on screen */
    } finally {
      setLoading(false)
    }
  }, [searchParams])

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    refetch()
  }, [paramsKey, refetch])

  // Keep the search box in sync if the URL search changes elsewhere (e.g. Clear).
  useEffect(() => { setSearchInput(urlSearch) }, [urlSearch])

  // Debounce the search input → URL (250ms).
  useEffect(() => {
    if (searchInput === urlSearch) return
    const t = setTimeout(() => updateParams({ search: searchInput || null }), 250)
    return () => clearTimeout(t)
  }, [searchInput, urlSearch, updateParams])

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) updateParams({ sort: key, dir: sortDir === 'asc' ? 'desc' : 'asc' })
    else updateParams({ sort: key, dir: 'asc' })
  }

  // Filter/select options: defined categories ∪ every category persisted across
  // the whole table (categoryOptions, from the server) ∪ the current page's rows
  // (so a category just typed into the Add form shows up immediately).
  const allCategories = useMemo(() => {
    const all = new Set<string>([
      ...categories.map((c) => c.name),
      ...categoryOptions,
      ...rows.map((t) => t.category).filter(Boolean),
    ])
    return [...all].sort()
  }, [rows, categories, categoryOptions])

  // ── Optimistic row patches + reconcile ───────────────────────────────────────
  const handleUpdate = useCallback((updated: Transaction) => {
    setRows((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
    refetch()
  }, [refetch])
  const handleUpdateById = useCallback((id: number, patch: Partial<Transaction>) => {
    setRows((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }, [])
  const handleDelete = useCallback((id: number) => {
    setRows((prev) => prev.filter((t) => t.id !== id))
    setSelectedIds((prev) => { const n = new Set(prev); n.delete(id); return n })
    refetch()
  }, [refetch])
  const toggleSelectRow = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id); else n.add(id)
      return n
    })
  }, [])

  // Bulk select helpers
  const pageIds = rows.map((t) => t.id)
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id))

  const toggleSelectAll = () => {
    if (allPageSelected) {
      setSelectedIds((prev) => { const n = new Set(prev); pageIds.forEach((id) => n.delete(id)); return n })
    } else {
      setSelectedIds((prev) => { const n = new Set(prev); pageIds.forEach((id) => n.add(id)); return n })
    }
  }

  const handleExport = () => {
    // Server streams the full filtered set (ignores pagination) as CSV; the
    // Content-Disposition header triggers the download without navigating.
    const params = new URLSearchParams(searchParams.toString())
    params.set('format', 'csv')
    window.location.href = `/api/transactions?${params.toString()}`
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
      setSelectedIds(new Set())
      setBulkCategory('')
      setBulkStatus('')
      toast.success(`Updated ${selectedIds.size} transaction${selectedIds.size !== 1 ? 's' : ''}`)
      refetch()
    } catch (e) {
      toast.error(`Bulk update failed: ${e instanceof Error ? e.message : String(e)}`)
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
    if (addType === 'transfer' && !addCounterpartId) {
      setAddError('Pick the other account for this transfer'); return
    }

    // Amount sign rules (see lib/accounts.ts):
    //   debit    → negative (money left the account)
    //   credit   → positive (money entered the account)
    //   transfer → signed by direction on the originating side; the API
    //              creates the counterpart row with the opposite sign.
    // API expects integer cents — convert at the boundary.
    const absCents = toCents(amt)
    const signedAmount =
      addType === 'debit' ? -absCents
      : addType === 'credit' ? absCents
      : addTransferDirection === 'out' ? -absCents : absCents

    setAddSaving(true); setAddError('')
    try {
      const res = await fetch('/api/transactions/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: addDate,
          description: desc,
          amount: signedAmount,
          transactionType: addType,
          category: addCategory || '',
          accountId: parseInt(addAccountId),
          notes: addNotes.trim() || undefined,
          status: addStatus,
          transferCounterpartAccountId:
            addType === 'transfer' ? parseInt(addCounterpartId) : null,
        }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error ?? 'Failed to add')
      }
      // Refetch the current page so the new row (and its transfer counterpart,
      // if any) appears in the correct sorted position with fresh stats.
      await refetch()
      // Reset form
      setAddDescription(''); setAddAmount(''); setAddNotes('')
      setAddDate(new Date().toISOString().split('T')[0])
      setAddCategory(''); setAddType('debit')
      setAddCounterpartId('')
      setAddTransferDirection('out')
      setShowAddForm(false)
    } catch (e) {
      setAddError(String(e instanceof Error ? e.message : e))
    } finally {
      setAddSaving(false)
    }
  }

  const hasFilters = accountFilter !== 'all' || typeFilter !== 'all' || categoryFilter !== 'all' || statusFilter !== 'all' || urlSearch || showPendingOnly
  const clearFilters = () => {
    setSearchInput('')
    updateParams({ accountId: null, type: null, category: null, status: null, search: null, pendingReimbursements: null })
  }

  const selectStyle: React.CSSProperties = { border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }

  return (
    <div className="space-y-5">
      {/* Page header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-page-title">
            Ledger
          </h1>
          <p className="mt-1 text-sm leading-[1.5]" style={{ color: 'var(--tx-secondary)' }}>
            All transactions — filter, edit, and manage.
          </p>
        </div>
        <Button
          variant="default"
          size="sm"
          onClick={() => { setShowAddForm((v) => !v); setAddError('') }}
          style={showAddForm ? { backgroundColor: 'var(--bg-card-alt)' } : undefined}
        >
          <Plus size={14} />
          Add
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Income',   value: `+${currency} ${fromCents(stats.income).toFixed(2)}`,   sub: `${stats.incomeCount} transaction${stats.incomeCount !== 1 ? 's' : ''}`,   bg: 'var(--bg-stat-income)',  tx: 'var(--tx-stat-income)' },
          { label: 'Expenses', value: `−${currency} ${fromCents(stats.expenses).toFixed(2)}`, sub: `${stats.expenseCount} transaction${stats.expenseCount !== 1 ? 's' : ''}`, bg: 'var(--bg-stat-expense)', tx: 'var(--tx-stat-expense)' },
          { label: 'Net',      value: `${stats.net >= 0 ? '+' : '−'}${currency} ${fromCents(Math.abs(stats.net)).toFixed(2)}`, sub: `${total} shown`, bg: 'var(--bg-stat-net)', tx: stats.net >= 0 ? 'var(--tx-stat-net-pos)' : 'var(--tx-stat-net-neg)' },
        ].map(({ label, value, sub, bg, tx }) => (
          <div key={label} className="card-hover p-5 rounded-[8px]" style={{ backgroundColor: bg, border: '1px solid var(--border-warm)' }}>
            <p className="text-card-label mb-2">{label}</p>
            <p className="amount text-xl font-semibold" style={{ color: tx, letterSpacing: '-0.5px' }}>{value}</p>
            <p className="text-xs mt-1" style={{ color: 'var(--tx-faint)' }}>{sub}</p>
          </div>
        ))}
      </div>

      {/* Multi-currency note — totals are base-currency; the list spans all. */}
      {showCurrencyNote && (
        <p className="text-xs -mt-2" style={{ color: 'var(--tx-tertiary)' }}>
          Totals are shown in {currency}. The list below includes accounts in other currencies —
          filter by account to see a single account&apos;s totals.
        </p>
      )}

      {/* Pending reimbursements banner */}
      {stats.pendingReimbursementCount > 0 && (
        <button
          onClick={() => updateParams({ pendingReimbursements: showPendingOnly ? null : '1' })}
          className="btn w-full flex items-center gap-2.5 px-4 py-3 rounded-[8px] text-sm text-left transition-colors duration-150"
          style={{
            backgroundColor: showPendingOnly ? 'var(--bg-badge-review)' : 'var(--bg-card)',
            border: '1px solid var(--border-warm)',
            color: 'var(--tx-badge-review)',
          }}
        >
          <RotateCcw size={14} style={{ flexShrink: 0 }} />
          <span>
            {stats.pendingReimbursementCount} pending reimbursement{stats.pendingReimbursementCount !== 1 ? 's' : ''} awaiting settlement
            {' — '}
            {currency}{fromCents(stats.pendingReimbursementOutstanding).toFixed(2)} outstanding
          </span>
          <span className="ml-auto text-xs" style={{ color: 'var(--tx-secondary)' }}>
            {showPendingOnly ? 'Show all' : 'Filter'}
          </span>
        </button>
      )}

      {/* Filters */}
      <Card className="p-4">
        <div className="flex flex-wrap gap-3 items-center">
          <input type="search" placeholder="Search descriptions…" value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="flex-1 min-w-[200px] px-3 py-2 text-sm rounded-[8px] outline-none transition-colors duration-150"
            style={selectStyle}
            onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--border-warm-md)')}
            onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border-warm)')}
          />
          {[
            { value: accountFilter, onChange: (v: string) => updateParams({ accountId: v }), options: [{ value: 'all', label: 'All accounts' }, ...accounts.map((a) => ({ value: String(a.id), label: a.name }))] },
            { value: typeFilter,    onChange: (v: string) => updateParams({ type: v }),      options: [{ value: 'all', label: 'All types' }, { value: 'debit', label: 'Debit' }, { value: 'credit', label: 'Credit' }, { value: 'transfer', label: 'Transfer' }] },
            { value: statusFilter,  onChange: (v: string) => updateParams({ status: v }),    options: [{ value: 'all', label: 'All statuses' }, { value: 'committed', label: 'Committed' }, { value: 'reconciled', label: 'Reconciled' }, { value: 'review', label: 'Review' }] },
          ].map(({ value, onChange, options }, i) => (
            <Select key={i} value={value} onValueChange={onChange} options={options} size="md" fullWidth={false} />
          ))}
          {/* Category filter — inline Radix (kept for its empty-state hint, which
              the shared Select primitive doesn't model). JS hover replaced by
              the .ui-select-item[data-highlighted] CSS rule; elevation → ambient. */}
          <RSelect.Root value={categoryFilter} onValueChange={(v) => updateParams({ category: v })}>
            <RSelect.Trigger
              className="flex items-center gap-2 px-3 py-2 text-sm rounded-[8px] outline-none"
              style={selectStyle}
              aria-label="Filter by category"
            >
              <RSelect.Value />
              <RSelect.Icon style={{ color: 'var(--tx-tertiary)' }}>
                <ChevronDown size={14} />
              </RSelect.Icon>
            </RSelect.Trigger>
            <RSelect.Portal>
              <RSelect.Content
                position="popper"
                sideOffset={4}
                className="z-50 overflow-hidden rounded-[8px]"
                style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-warm)', boxShadow: 'var(--shadow-ambient)', minWidth: 'var(--radix-select-trigger-width)' }}
              >
                <RSelect.Viewport className="p-1">
                  <RSelect.Item
                    value="all"
                    className="ui-select-item px-3 py-2 text-sm rounded-[6px] cursor-pointer outline-none select-none transition-colors duration-100"
                    style={{ color: 'var(--tx-primary)' }}
                  >
                    <RSelect.ItemText>All categories</RSelect.ItemText>
                  </RSelect.Item>
                  {categories.length === 0 && (
                    <div className="flex items-center gap-1.5 px-3 py-1.5">
                      <AlertCircle size={11} strokeWidth={1.5} style={{ color: 'var(--tx-tertiary)' }} />
                      <span className="text-[11px]" style={{ color: 'var(--tx-tertiary)' }}>No custom categories yet</span>
                    </div>
                  )}
                  {allCategories.map((c) => (
                    <RSelect.Item
                      key={c}
                      value={c}
                      className="ui-select-item px-3 py-2 text-sm rounded-[6px] cursor-pointer outline-none select-none transition-colors duration-100"
                      style={{ color: 'var(--tx-primary)' }}
                    >
                      <RSelect.ItemText>{c}</RSelect.ItemText>
                    </RSelect.Item>
                  ))}
                </RSelect.Viewport>
              </RSelect.Content>
            </RSelect.Portal>
          </RSelect.Root>
          {hasFilters && (
            <button onClick={clearFilters}
              className="btn text-sm transition-colors duration-150 hover:text-error" style={{ color: 'var(--tx-secondary)' }}>
              Clear
            </button>
          )}
          <button
            onClick={handleExport}
            disabled={total === 0}
            className="btn flex items-center gap-1.5 text-sm transition-colors duration-150 disabled:opacity-30 ml-auto"
            style={{ color: 'var(--tx-secondary)' }}
            title="Export filtered view as CSV"
          >
            <Download size={14} />
            Export
          </button>
        </div>
      </Card>

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
              <DatePicker value={addDate} onChange={setAddDate} />
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
                    className="btn px-2.5 py-1.5 text-xs capitalize"
                    style={{
                      backgroundColor: addType === t
                        ? t === 'debit' ? 'var(--bg-stat-expense)' : t === 'credit' ? 'var(--bg-stat-income)' : 'var(--bg-transfer-strong)'
                        : 'var(--bg-input)',
                      color: addType === t
                        ? t === 'debit' ? 'var(--tx-stat-expense)' : t === 'credit' ? 'var(--tx-stat-income)' : 'var(--tx-transfer)'
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
            {addType === 'transfer' && (
              <>
                <div>
                  <label className="block text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--tx-tertiary)' }}>Direction</label>
                  <select
                    value={addTransferDirection}
                    onChange={(e) => setAddTransferDirection(e.target.value as 'in' | 'out')}
                    className="px-2 py-1.5 text-sm rounded-[6px] outline-none"
                    style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }}
                  >
                    <option value="out">↑ Out</option>
                    <option value="in">↓ In</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--tx-tertiary)' }}>
                    {addTransferDirection === 'out' ? 'To account' : 'From account'}
                  </label>
                  <select
                    value={addCounterpartId}
                    onChange={(e) => setAddCounterpartId(e.target.value)}
                    className="px-2 py-1.5 text-sm rounded-[6px] outline-none"
                    style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-input)', color: 'var(--tx-primary)' }}
                  >
                    <option value="">— pick —</option>
                    {accounts
                      .filter((a) => String(a.id) !== addAccountId)
                      .map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
              </>
            )}
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
            <Button variant="primary" size="sm" onClick={handleAddTransaction} disabled={addSaving}>
              {addSaving ? '…' : 'Save'}
            </Button>
            {addError && <span className="text-xs" style={{ color: 'var(--tx-error)' }}>{addError}</span>}
          </div>
        </div>
      )}

      {/* Table */}
      <div className="overflow-hidden rounded-[8px]" style={{ border: '1px solid var(--border-warm)', opacity: loading ? 0.6 : 1, transition: 'opacity 120ms' }}>
        {rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3" style={{ color: 'var(--tx-tertiary)', backgroundColor: 'var(--bg-card)' }}>
            <span className="text-3xl opacity-30">—</span>
            <p className="text-sm">
              {total === 0 && !hasFilters ? 'No transactions yet. Upload a statement to get started.' : 'No transactions match the current filters.'}
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
                {rows.map((t) => (
                  <LedgerRow
                    key={t.id}
                    transaction={t}
                    accounts={accounts}
                    categories={categories}
                    onUpdate={handleUpdate}
                    onUpdateById={handleUpdateById}
                    onDelete={handleDelete}
                    selected={selectedIds.has(t.id)}
                    onToggleSelect={toggleSelectRow}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between px-3 py-2 rounded-[8px] text-xs"
          style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-warm)', color: 'var(--tx-secondary)' }}>
          <span>
            Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex gap-2">
            <button
              disabled={page <= 1}
              onClick={() => updateParams({ page: String(page - 1) }, { resetPage: false })}
              className="btn px-3 py-1 rounded-[6px] transition-colors duration-150 disabled:opacity-30"
              style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-btn)', color: 'var(--tx-primary)' }}>
              Prev
            </button>
            <button
              disabled={page >= totalPages}
              onClick={() => updateParams({ page: String(page + 1) }, { resetPage: false })}
              className="btn px-3 py-1 rounded-[6px] transition-colors duration-150 disabled:opacity-30"
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
          <Button
            variant="primary"
            size="sm"
            onClick={handleBulkApply}
            disabled={bulkApplying || (!bulkCategory && !bulkStatus)}
            className="px-3 py-1 text-xs"
          >
            {bulkApplying ? '…' : 'Apply'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setSelectedIds(new Set()); setBulkCategory(''); setBulkStatus('') }}
            className="text-xs"
          >
            Clear
          </Button>
        </div>
      )}
    </div>
  )
}
