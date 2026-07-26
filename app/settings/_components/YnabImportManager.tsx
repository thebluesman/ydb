'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, ArrowDownToLine, RefreshCw } from 'lucide-react'
import { Select, Button, Modal, useToast } from '@/app/_components/ui'

// Phase 1 of the YNAB migration (ADR-0002): a manual, user-initiated pull.
// Three steps — map accounts, preview, confirm — mirroring the phase state
// machine in CsvImportFlow, but scoped to account mapping only. There is no
// per-row review table: YNAB data is already structured and trusted, unlike the
// OCR/LLM-parsed statements the CSV/PDF flow has to second-guess.
type Phase = 'idle' | 'mapping' | 'importing' | 'done'

type YnabAccount = { id: string; name: string; type: string; closed: boolean }
type YdbAccount = { id: number; name: string; accountType: string; currency: string }

type Summary = {
  count: number
  transfersCount: number
  accountBreakdown: { accountName: string; count: number }[]
  dateRange: [string, string] | null
  categories: number
  skippedAlreadyImported: number
  skippedTransfersIncomplete: number
  skippedTransfersCrossCurrency: number
  skippedDeleted: number
  skippedUnmappedAccounts: string[]
}

type ImportResult = { imported: number; transfersImported: number; planned: number; accounts: number }

const UNMAPPED = '__unmapped__'

// YNAB's account `type` values are camelCase API tokens; the mapping table
// reads better with the labels YNAB itself shows.
const YNAB_TYPE_LABELS: Record<string, string> = {
  checking: 'Checking',
  savings: 'Savings',
  cash: 'Cash',
  creditCard: 'Credit card',
  lineOfCredit: 'Line of credit',
  otherAsset: 'Other asset',
  otherLiability: 'Other liability',
  mortgage: 'Mortgage',
  autoLoan: 'Auto loan',
  studentLoan: 'Student loan',
  personalLoan: 'Personal loan',
  medicalDebt: 'Medical debt',
  otherDebt: 'Other debt',
}

function typeLabel(type: string): string {
  return YNAB_TYPE_LABELS[type] ?? type
}

export function YnabImportManager() {
  const router = useRouter()
  const toast = useToast()

  const [phase, setPhase] = useState<Phase>('idle')
  const [loading, setLoading] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [error, setError] = useState('')

  const [ynabAccounts, setYnabAccounts] = useState<YnabAccount[]>([])
  const [ydbAccounts, setYdbAccounts] = useState<YdbAccount[]>([])
  const [map, setMap] = useState<Record<string, number>>({})
  const [hasImportedBefore, setHasImportedBefore] = useState(false)

  const [summary, setSummary] = useState<Summary | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)

  // Only open accounts must be mapped. Closed YNAB accounts still appear in the
  // table so historical rows on them can be routed, but leaving one unmapped is
  // a legitimate choice, not an error.
  const openAccounts = ynabAccounts.filter((a) => !a.closed)
  const unmappedOpen = openAccounts.filter((a) => map[a.id] == null)
  const canPreview = unmappedOpen.length === 0 && Object.keys(map).length > 0

  async function loadAccounts() {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/ynab/accounts')
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Could not load YNAB accounts')
      setYnabAccounts(data.ynabAccounts ?? [])
      setYdbAccounts(data.ydbAccounts ?? [])
      setMap(data.accountMap ?? {})
      setHasImportedBefore(Boolean(data.hasImportedBefore))
      setPhase('mapping')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load YNAB accounts')
    } finally {
      setLoading(false)
    }
  }

  async function runPreview() {
    setPreviewing(true)
    setError('')
    try {
      const res = await fetch('/api/ynab/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountMap: map }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Could not preview the import')
      setSummary(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not preview the import')
    } finally {
      setPreviewing(false)
    }
  }

  async function runImport() {
    setPhase('importing')
    setError('')
    try {
      const res = await fetch('/api/ynab/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountMap: map }),
      })
      const data = await res.json()
      if (!res.ok) {
        // Sign-rule rejections come back with a human-readable `message` and
        // roll the whole batch back — surface it verbatim rather than the
        // generic error, so a mis-mapped row is diagnosable.
        throw new Error(data?.message ?? data?.error ?? 'The import failed')
      }
      setResult(data)
      setSummary(null)
      setPhase('done')
      toast.success(
        data.imported === 0
          ? 'Nothing new to import — YDB is already up to date with YNAB'
          : `Imported ${data.imported} transaction${data.imported === 1 ? '' : 's'} from YNAB`,
      )
      router.refresh()
    } catch (err) {
      setSummary(null)
      setPhase('mapping')
      const message = err instanceof Error ? err.message : 'The import failed'
      setError(message)
      toast.error('The YNAB import failed — nothing was written')
    }
  }

  const ydbOptions = [
    { value: UNMAPPED, label: '— not imported —' },
    ...ydbAccounts.map((a) => ({ value: String(a.id), label: `${a.name} (${a.currency})` })),
  ]

  if (phase === 'done' && result) {
    return (
      <div className="space-y-4">
        <div
          className="px-3 py-2.5 rounded-[6px] text-sm"
          style={{
            backgroundColor: 'var(--bg-notify-success)',
            color: 'var(--tx-notify-success)',
          }}
        >
          {result.imported === 0 ? (
            <p>Nothing new to import — YDB is already up to date with YNAB.</p>
          ) : (
            <p>
              Imported {result.imported} transaction{result.imported === 1 ? '' : 's'} across{' '}
              {result.accounts} account{result.accounts === 1 ? '' : 's'}
              {result.transfersImported > 0 && (
                <>
                  {' '}(including {result.transfersImported} transfer{result.transfersImported === 1 ? '' : 's'} —
                  credit card/loan payments between mapped accounts)
                </>
              )}
              .
            </p>
          )}
        </div>
        <Button variant="default" size="sm" onClick={() => { setResult(null); setPhase('idle') }}>
          Done
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {error && (
        <div
          className="flex items-start gap-2.5 px-3 py-2.5 rounded-[6px] text-xs"
          style={{ backgroundColor: 'var(--bg-notify-error)', color: 'var(--tx-notify-error)' }}
        >
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
          <p>{error}</p>
        </div>
      )}

      {phase === 'idle' && (
        <Button variant="default" size="sm" onClick={loadAccounts} disabled={loading}>
          {loading ? 'Connecting to YNAB…' : 'Import from YNAB'}
        </Button>
      )}

      {(phase === 'mapping' || phase === 'importing') && (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs" style={{ color: 'var(--tx-secondary)' }}>
              {hasImportedBefore
                ? 'Only transactions changed since the last import will be pulled.'
                : 'First import — the full YNAB history will be pulled.'}
            </p>
            <button
              onClick={loadAccounts}
              disabled={loading || phase === 'importing'}
              className="btn flex items-center gap-1.5 text-xs px-2 py-1 rounded-[var(--radius-sm)] disabled:opacity-50"
              style={{
                color: 'var(--tx-secondary)',
                border: '1px solid var(--border-warm)',
                backgroundColor: 'var(--bg-input)',
              }}
            >
              <RefreshCw size={12} />
              Reload accounts
            </button>
          </div>

          {ynabAccounts.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--tx-secondary)' }}>
              No accounts on the YNAB budget.
            </p>
          ) : (
            <div
              className="rounded-[6px] overflow-hidden"
              style={{ border: '1px solid var(--border-warm)' }}
            >
              {ynabAccounts.map((a, i) => (
                <div
                  key={a.id}
                  className="flex items-center justify-between gap-3 px-3 py-2.5"
                  style={{
                    backgroundColor: 'var(--bg-card)',
                    borderTop: i > 0 ? '1px solid var(--border-warm)' : undefined,
                  }}
                >
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-sm truncate" style={{ color: 'var(--tx-primary)' }}>
                      {a.name}
                    </span>
                    <span className="text-xs" style={{ color: 'var(--tx-secondary)' }}>
                      {typeLabel(a.type)}
                      {a.closed && ' · closed in YNAB'}
                    </span>
                  </div>
                  <div className="flex-shrink-0" style={{ minWidth: '190px' }}>
                    <Select
                      value={map[a.id] != null ? String(map[a.id]) : UNMAPPED}
                      onValueChange={(v) => {
                        setSummary(null)
                        setMap((prev) => {
                          const next = { ...prev }
                          if (v === UNMAPPED) delete next[a.id]
                          else next[a.id] = Number(v)
                          return next
                        })
                      }}
                      ariaLabel={`YDB account for YNAB account ${a.name}`}
                      size="sm"
                      fullWidth
                      options={ydbOptions}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          {unmappedOpen.length > 0 && (
            <p className="text-xs" style={{ color: 'var(--tx-secondary)' }}>
              Map every open YNAB account before importing — still unmapped:{' '}
              {unmappedOpen.map((a) => a.name).join(', ')}.
            </p>
          )}

          <div className="flex items-center gap-2">
            <Button
              variant="default"
              size="sm"
              onClick={runPreview}
              disabled={!canPreview || previewing || phase === 'importing'}
            >
              {previewing ? 'Checking YNAB…' : 'Preview import'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setPhase('idle'); setSummary(null); setError('') }}
              disabled={phase === 'importing'}
            >
              Cancel
            </Button>
          </div>
        </>
      )}

      <Modal
        open={summary != null}
        onClose={() => { if (phase !== 'importing') setSummary(null) }}
        title="Import from YNAB?"
        maxWidth={480}
      >
        {summary && (
          <div className="space-y-4">
            {summary.count === 0 ? (
              <p className="text-sm" style={{ color: 'var(--tx-secondary)' }}>
                Nothing new to import — every transaction YNAB returned is already in YDB.
              </p>
            ) : (
              <>
                <p className="text-sm" style={{ color: 'var(--tx-primary)' }}>
                  <span className="font-medium">{summary.count}</span> transaction
                  {summary.count === 1 ? '' : 's'} will be imported
                  {summary.dateRange && (
                    <>
                      , dated {summary.dateRange[0]} to {summary.dateRange[1]}
                    </>
                  )}
                  , across {summary.categories} categor{summary.categories === 1 ? 'y' : 'ies'}.
                  {summary.transfersCount > 0 && (
                    <>
                      {' '}Includes {summary.transfersCount} transfer{summary.transfersCount === 1 ? '' : 's'}{' '}
                      (credit card/loan payments between mapped accounts).
                    </>
                  )}
                </p>
                <div
                  className="rounded-[6px] overflow-hidden"
                  style={{ border: '1px solid var(--border-warm)' }}
                >
                  {summary.accountBreakdown.map((b, i) => (
                    <div
                      key={b.accountName}
                      className="flex items-center justify-between px-3 py-1.5 text-xs"
                      style={{ borderTop: i > 0 ? '1px solid var(--border-warm)' : undefined }}
                    >
                      <span style={{ color: 'var(--tx-primary)' }}>{b.accountName}</span>
                      <span style={{ color: 'var(--tx-secondary)' }}>{b.count}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <ul className="text-xs space-y-1" style={{ color: 'var(--tx-secondary)' }}>
              {summary.skippedAlreadyImported > 0 && (
                <li>{summary.skippedAlreadyImported} already imported (skipped)</li>
              )}
              {summary.skippedTransfersIncomplete > 0 && (
                <li>
                  {summary.skippedTransfersIncomplete} transfer(s) skipped — the other side wasn&apos;t returned by
                  YNAB (e.g. a closed account)
                </li>
              )}
              {summary.skippedTransfersCrossCurrency > 0 && (
                <li>
                  {summary.skippedTransfersCrossCurrency} transfer(s) skipped — the mapped accounts don&apos;t
                  share a currency
                </li>
              )}
              {summary.skippedDeleted > 0 && (
                <li>{summary.skippedDeleted} deleted in YNAB (skipped)</li>
              )}
              {summary.skippedUnmappedAccounts.length > 0 && (
                <li>
                  Rows on unmapped account(s) skipped:{' '}
                  {summary.skippedUnmappedAccounts.join(', ')}
                </li>
              )}
            </ul>

            <p className="text-xs" style={{ color: 'var(--tx-faint)' }}>
              Imported transactions are committed straight to the ledger. Re-running an import never
              duplicates rows.
            </p>

            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSummary(null)}
                disabled={phase === 'importing'}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={runImport}
                disabled={phase === 'importing'}
                className="flex items-center gap-1.5"
              >
                <ArrowDownToLine size={14} />
                {phase === 'importing' ? 'Importing…' : 'Confirm & import'}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
