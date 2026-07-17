'use client'

import React, { useEffect, useState } from 'react'
import { CheckCircle } from 'lucide-react'
import { FileDropzone } from './FileDropzone'
import { ReviewTable, type DraftTransaction } from './ReviewTable'
import { Select, Button } from '@/app/_components/ui'
import {
  parseCsv,
  applyCsvMapping,
  parseOfx,
  looksLikeOfx,
  isMappingComplete,
  CSV_DATE_FORMATS,
  type CsvMapping,
  type CsvDateFormat,
  type MappedTransaction,
} from '@/lib/csvImport'
import { findMatchingRule } from '@/lib/vendor-rule-match'
import { toCents } from '@/lib/money'

type Account = { id: number; name: string; currency: string; accountType: string }
type Category = { id: number; name: string; color: string }
type Phase = 'idle' | 'mapping' | 'review' | 'done'

const cardStyle: React.CSSProperties = {
  backgroundColor: 'var(--bg-card)',
  border: '1px solid var(--border-warm)',
  borderRadius: '8px',
}

const NO_COL = '__none__'

function colOptions(headerRow: string[] | null, rowCount: number) {
  const count = headerRow ? headerRow.length : rowCount
  return Array.from({ length: count }, (_, i) => ({
    value: String(i),
    label: headerRow?.[i]?.trim() ? `${headerRow[i]} (col ${i + 1})` : `Column ${i + 1}`,
  }))
}

export function CsvImportFlow({ accounts, categories }: { accounts: Account[]; categories: Category[] }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [selectedAccountId, setSelectedAccountId] = useState<number>(accounts[0]?.id ?? 0)
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const [rows, setRows] = useState<string[][]>([])
  const [hasHeaderRow, setHasHeaderRow] = useState(true)
  const [dateCol, setDateCol] = useState<number | null>(null)
  const [descriptionCol, setDescriptionCol] = useState<number | null>(null)
  const [amountMode, setAmountMode] = useState<'single' | 'split'>('single')
  const [amountCol, setAmountCol] = useState<number | null>(null)
  const [debitCol, setDebitCol] = useState<number | null>(null)
  const [creditCol, setCreditCol] = useState<number | null>(null)
  const [dateFormat, setDateFormat] = useState<CsvDateFormat>('YYYY-MM-DD')
  const [skipped, setSkipped] = useState(0)
  const [drafts, setDrafts] = useState<DraftTransaction[]>([])
  const [committedCount, setCommittedCount] = useState(0)
  const [savedMapping, setSavedMapping] = useState(false)

  const reset = () => {
    setPhase('idle'); setFile(null); setError(''); setRows([])
    setDateCol(null); setDescriptionCol(null); setAmountCol(null)
    setDebitCol(null); setCreditCol(null); setSkipped(0); setDrafts([])
  }

  // Load a previously-saved mapping for the selected account, if any, so
  // re-imports of the same bank's export are one click (IMPROVEMENT_PLAN
  // Phase 7 item 1: "store the mapping per account in Settings"). The
  // synchronous reset clears the stale "saved" indicator from the previous
  // account before the fetch for the new account resolves.
  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- must clear stale flag from prior account synchronously, before the fetch below resolves
    setSavedMapping(false)
    fetch('/api/settings')
      .then((r) => r.json())
      .then((settings: { key: string; value: string }[]) => {
        if (cancelled) return
        const s = settings.find((x) => x.key === `csvMapping:${selectedAccountId}`)
        if (s) setSavedMapping(true)
      })
      .catch(() => { /* non-critical */ })
    return () => { cancelled = true }
  }, [selectedAccountId])

  async function loadSavedMapping() {
    try {
      const res = await fetch('/api/settings')
      if (!res.ok) return
      const settings: { key: string; value: string }[] = await res.json()
      const s = settings.find((x) => x.key === `csvMapping:${selectedAccountId}`)
      if (!s) return
      const m: CsvMapping = JSON.parse(s.value)
      setHasHeaderRow(m.hasHeaderRow)
      setDateCol(m.dateCol); setDescriptionCol(m.descriptionCol)
      setDateFormat(m.dateFormat)
      if (m.amountCol != null) { setAmountMode('single'); setAmountCol(m.amountCol) }
      else { setAmountMode('split'); setDebitCol(m.debitCol); setCreditCol(m.creditCol) }
    } catch { /* ignore malformed saved mapping */ }
  }

  async function handleFile(f: File) {
    setError(''); setFile(f)
    const text = await f.text()
    if (looksLikeOfx(f.name, text)) {
      const parsed = parseOfx(text)
      if (parsed.length === 0) {
        setError('No transactions found in this OFX/QFX file.')
        return
      }
      finishMapping(parsed)
      return
    }
    const parsedRows = parseCsv(text)
    if (parsedRows.length === 0) {
      setError('The file appears to be empty.')
      return
    }
    setRows(parsedRows)
    setPhase('mapping')
    await loadSavedMapping()
  }

  const headerRow = hasHeaderRow ? rows[0] ?? null : null

  function buildMapping(): CsvMapping | null {
    const partial = {
      dateCol: dateCol ?? undefined,
      descriptionCol: descriptionCol ?? undefined,
      dateFormat,
      amountCol: amountMode === 'single' ? amountCol : null,
      debitCol: amountMode === 'split' ? debitCol : null,
      creditCol: amountMode === 'split' ? creditCol : null,
      hasHeaderRow,
    }
    return isMappingComplete(partial) ? (partial as CsvMapping) : null
  }

  function applyMapping() {
    const mapping = buildMapping()
    if (!mapping) { setError('Map date, description, and an amount column (or debit + credit) first.'); return }
    const { transactions, skipped: skippedCount } = applyCsvMapping(rows, mapping)
    if (transactions.length === 0) {
      setError('No valid rows could be parsed with this mapping. Check the column and date-format choices.')
      return
    }
    // Fire-and-forget: remember this mapping for one-click re-imports.
    fetch('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: `csvMapping:${selectedAccountId}`, value: JSON.stringify(mapping) }),
    }).catch(() => { /* non-critical */ })
    setSkipped(skippedCount)
    finishMapping(transactions)
  }

  function finishMapping(transactions: MappedTransaction[]) {
    void (async () => {
      let patterns: { id: number; pattern: string; matchType: string; vendor: string; category: string; direction: string; transactionType: string | null; minAmount: number | null; maxAmount: number | null; priority: number }[] = []
      try {
        const pr = await fetch('/api/vendor-rules')
        if (pr.ok) patterns = await pr.json()
      } catch { /* non-critical */ }

      setDrafts(transactions.map((t) => {
        const match = patterns.length > 0 ? findMatchingRule(patterns, t.description, toCents(t.amount)) : null
        return {
          _id: crypto.randomUUID(),
          date: t.date,
          description: match ? match.vendor : t.description,
          originalDescription: t.description,
          amount: t.amount,
          transactionType: (match?.transactionType) ?? t.transactionType,
          category: match ? match.category : 'Other',
          accountId: selectedAccountId,
          notes: '',
          rawSource: '',
        }
      }))
      setPhase('review')
    })()
  }

  async function handleCommit() {
    const payload = drafts.map(({ _id: _, amount, ...t }) => ({ ...t, amount: toCents(amount) }))
    const res = await fetch('/api/transactions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(err.error ?? 'Failed to save')
    }
    const { count } = await res.json()
    fetch('/api/import-records', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file?.name ?? 'unknown', accountId: selectedAccountId, transactionCount: count }),
    }).catch(() => { /* non-critical */ })
    setCommittedCount(count)
    setPhase('done')
  }

  if (phase === 'done') {
    return (
      <div className="py-16 text-center space-y-4 rounded-[8px]" style={{ ...cardStyle, animation: 'ydb-page-in 0.25s cubic-bezier(0.22,1,0.36,1) both' }}>
        <CheckCircle size={40} style={{ color: 'var(--tx-success)', margin: '0 auto' }} />
        <h2 className="text-[22px] font-semibold" style={{ letterSpacing: '-0.11px', color: 'var(--tx-primary)' }}>
          {committedCount} transaction{committedCount !== 1 ? 's' : ''} saved
        </h2>
        <p className="text-sm" style={{ color: 'var(--tx-secondary)' }}>They are now in your ledger.</p>
        <div className="flex items-center justify-center gap-3">
          <button onClick={reset}
            className="btn px-[14px] py-[10px] rounded-[8px] text-sm font-semibold transition-colors duration-150 hover:text-error"
            style={{ backgroundColor: 'var(--bg-btn)', border: '1px solid var(--border-warm)', color: 'var(--tx-primary)' }}>
            Import another
          </button>
          <a href="/ledger?status=review"
            className="btn px-[14px] py-[10px] rounded-[8px] text-sm font-semibold transition-colors duration-150"
            style={{ backgroundColor: 'var(--color-accent)', color: '#fff' }}>
            Review them in the ledger →
          </a>
        </div>
      </div>
    )
  }

  if (phase === 'review') {
    return (
      <div className="p-6 rounded-[8px]" style={{ ...cardStyle, animation: 'ydb-page-in 0.25s cubic-bezier(0.22,1,0.36,1) both' }}>
        {skipped > 0 && (
          <p className="text-xs mb-3 px-3 py-2 rounded-[6px]" style={{ backgroundColor: 'var(--bg-notify-error)', color: 'var(--tx-notify-error)' }}>
            {skipped} row{skipped !== 1 ? 's' : ''} could not be parsed with this mapping and were skipped.
          </p>
        )}
        <ReviewTable drafts={drafts} accounts={accounts} categories={categories}
          onChange={setDrafts} onCommit={handleCommit} onDiscard={reset} />
      </div>
    )
  }

  const cols = colOptions(headerRow, rows[0]?.length ?? 0)
  const withNone = [{ value: NO_COL, label: '— none —' }, ...cols]

  return (
    <div className="space-y-4">
      {/* Account selector */}
      <div className="p-6 space-y-3 rounded-[8px]" style={cardStyle}>
        <p className="text-[11px] font-medium uppercase tracking-[0.048px]" style={{ color: 'var(--tx-secondary)' }}>Account</p>
        {accounts.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--tx-secondary)' }}>
            No accounts yet. <a href="/settings" style={{ color: '#f54e00', textDecoration: 'underline' }}>Configure accounts first.</a>
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {accounts.map((a) => (
              <button key={a.id} onClick={() => setSelectedAccountId(a.id)} disabled={phase !== 'idle'}
                className="btn px-3 py-1.5 rounded-full text-sm transition-colors duration-150"
                style={selectedAccountId === a.id
                  ? { backgroundColor: 'var(--bg-selected)', color: 'var(--tx-selected)', border: '1px solid var(--bg-selected)' }
                  : { backgroundColor: 'var(--bg-btn)', color: 'var(--tx-secondary)', border: '1px solid var(--border-warm)' }
                }>
                {a.name || `Account ${a.id}`}
              </button>
            ))}
          </div>
        )}
        {savedMapping && phase === 'idle' && (
          <p className="text-xs" style={{ color: 'var(--tx-tertiary)' }}>
            A saved column mapping exists for this account — it will be pre-filled once you pick a CSV file.
          </p>
        )}
      </div>

      {/* Drop zone */}
      <div className="p-6 space-y-5 rounded-[8px]" style={cardStyle}>
        <p className="text-[11px] font-medium uppercase tracking-[0.048px]" style={{ color: 'var(--tx-secondary)' }}>Statement File (CSV / OFX / QFX)</p>
        <FileDropzone
          file={file}
          onFile={handleFile}
          onClear={reset}
          disabled={phase !== 'idle' && phase !== 'mapping'}
          accept={{ 'text/csv': ['.csv'], 'application/vnd.intu.qfx': ['.qfx'], 'application/x-ofx': ['.ofx'], 'text/plain': ['.csv', '.ofx', '.qfx'] }}
          hint="CSV, OFX, or QFX export from your bank"
        />

        {error && (
          <div className="text-sm px-4 py-3 rounded-[8px] whitespace-pre-wrap"
            style={{ backgroundColor: 'var(--bg-notify-error)', color: 'var(--tx-notify-error)' }}>
            {error}
          </div>
        )}

        {phase === 'mapping' && (
          <div className="space-y-4 pt-1">
            <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--tx-secondary)' }}>
              <input type="checkbox" checked={hasHeaderRow} onChange={(e) => setHasHeaderRow(e.target.checked)} />
              First row is a header
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <p className="text-xs font-medium" style={{ color: 'var(--tx-secondary)' }}>Date column</p>
                <Select value={dateCol == null ? NO_COL : String(dateCol)}
                  onValueChange={(v) => setDateCol(v === NO_COL ? null : Number(v))}
                  ariaLabel="Date column" size="sm" options={withNone} />
              </div>
              <div className="space-y-1.5">
                <p className="text-xs font-medium" style={{ color: 'var(--tx-secondary)' }}>Date format</p>
                <Select value={dateFormat} onValueChange={(v) => setDateFormat(v as CsvDateFormat)}
                  ariaLabel="Date format" size="sm"
                  options={CSV_DATE_FORMATS.map((f) => ({ value: f.value, label: f.label }))} />
              </div>
              <div className="space-y-1.5">
                <p className="text-xs font-medium" style={{ color: 'var(--tx-secondary)' }}>Description column</p>
                <Select value={descriptionCol == null ? NO_COL : String(descriptionCol)}
                  onValueChange={(v) => setDescriptionCol(v === NO_COL ? null : Number(v))}
                  ariaLabel="Description column" size="sm" options={withNone} />
              </div>
              <div className="space-y-1.5">
                <p className="text-xs font-medium" style={{ color: 'var(--tx-secondary)' }}>Amount columns</p>
                <Select value={amountMode} onValueChange={(v) => setAmountMode(v as 'single' | 'split')}
                  ariaLabel="Amount mode" size="sm"
                  options={[{ value: 'single', label: 'Single signed amount column' }, { value: 'split', label: 'Separate debit + credit columns' }]} />
              </div>

              {amountMode === 'single' ? (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium" style={{ color: 'var(--tx-secondary)' }}>Amount column</p>
                  <Select value={amountCol == null ? NO_COL : String(amountCol)}
                    onValueChange={(v) => setAmountCol(v === NO_COL ? null : Number(v))}
                    ariaLabel="Amount column" size="sm" options={withNone} />
                </div>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium" style={{ color: 'var(--tx-secondary)' }}>Debit column</p>
                    <Select value={debitCol == null ? NO_COL : String(debitCol)}
                      onValueChange={(v) => setDebitCol(v === NO_COL ? null : Number(v))}
                      ariaLabel="Debit column" size="sm" options={withNone} />
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium" style={{ color: 'var(--tx-secondary)' }}>Credit column</p>
                    <Select value={creditCol == null ? NO_COL : String(creditCol)}
                      onValueChange={(v) => setCreditCol(v === NO_COL ? null : Number(v))}
                      ariaLabel="Credit column" size="sm" options={withNone} />
                  </div>
                </>
              )}
            </div>

            {rows.length > (hasHeaderRow ? 1 : 0) && (
              <div className="overflow-x-auto rounded-[6px]" style={{ border: '1px solid var(--border-warm)' }}>
                <table className="text-xs w-full">
                  <tbody>
                    {rows.slice(hasHeaderRow ? 1 : 0, (hasHeaderRow ? 1 : 0) + 3).map((r, i) => (
                      <tr key={i}>
                        {r.map((c, j) => (
                          <td key={j} className="px-2 py-1 whitespace-nowrap" style={{ borderTop: i > 0 ? '1px solid var(--border-warm)' : undefined, color: 'var(--tx-secondary)' }}>
                            {c}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex items-center gap-2 pt-1">
              <Button variant="primary" size="md" onClick={applyMapping}>
                Apply mapping &amp; preview
              </Button>
              <Button variant="ghost" size="sm" onClick={reset}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
