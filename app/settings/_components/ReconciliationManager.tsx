'use client'

import { useState } from 'react'
import { CheckCircle2, AlertTriangle } from 'lucide-react'
import { DatePicker } from '@/app/_components/DatePicker'
import { Select, Button, useToast } from '@/app/_components/ui'
import { fromCents } from '@/lib/money'

type Account = {
  id: number
  name: string
  currency: string
  lastReconciledAt?: string | null
  lastReconciledBalance?: number | null
}

type ReconcileResult = {
  computedBalance: number
  statementBalance: number
  delta: number
  balanced: boolean
  committed?: boolean
}

function todayIso() {
  return new Date().toISOString().split('T')[0]
}

export function ReconciliationManager({ accounts }: { accounts: Account[] }) {
  const toast = useToast()
  const [accountId, setAccountId] = useState<number | null>(accounts[0]?.id ?? null)
  const [date, setDate] = useState(todayIso())
  const [statementBalance, setStatementBalance] = useState('')
  const [result, setResult] = useState<ReconcileResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [committing, setCommitting] = useState(false)

  const account = accounts.find((a) => a.id === accountId) ?? null

  async function check() {
    if (accountId == null) return
    const amount = parseFloat(statementBalance)
    if (!Number.isFinite(amount)) { toast.error('Enter the statement closing balance'); return }
    setLoading(true); setResult(null)
    try {
      const res = await fetch(`/api/accounts/${accountId}/reconcile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ statementBalance: amount, date }),
      })
      if (!res.ok) throw new Error(await res.text())
      setResult(await res.json())
    } catch {
      toast.error('Could not compute reconciliation')
    } finally {
      setLoading(false)
    }
  }

  async function commit() {
    if (accountId == null) return
    const amount = parseFloat(statementBalance)
    setCommitting(true)
    try {
      const res = await fetch(`/api/accounts/${accountId}/reconcile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ statementBalance: amount, date, commit: true }),
      })
      if (!res.ok) throw new Error(await res.text())
      const data = await res.json()
      setResult(data)
      if (data.committed) toast.success('Transactions through this date marked reconciled')
    } catch {
      toast.error('Failed to mark transactions reconciled')
    } finally {
      setCommitting(false)
    }
  }

  const inputStyle = {
    border: '1px solid var(--border-warm)',
    backgroundColor: 'var(--bg-input)',
    color: 'var(--tx-primary)',
    borderRadius: '6px',
    fontSize: '13px',
    padding: '6px 10px',
  }

  if (accounts.length === 0) {
    return <p className="text-sm" style={{ color: 'var(--tx-secondary)' }}>No accounts yet.</p>
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <p className="text-xs font-medium" style={{ color: 'var(--tx-secondary)' }}>Account</p>
          <Select
            value={String(accountId ?? '')}
            onValueChange={(v) => { setAccountId(Number(v)); setResult(null) }}
            ariaLabel="Account"
            size="sm"
            options={accounts.map((a) => ({ value: String(a.id), label: a.name }))}
          />
        </div>
        <div className="space-y-1.5">
          <p className="text-xs font-medium" style={{ color: 'var(--tx-secondary)' }}>Statement date</p>
          <DatePicker value={date} onChange={(v) => { setDate(v); setResult(null) }} size="sm" />
        </div>
        <div className="space-y-1.5">
          <p className="text-xs font-medium" style={{ color: 'var(--tx-secondary)' }}>Statement closing balance</p>
          <input
            type="number"
            step="0.01"
            value={statementBalance}
            onChange={(e) => { setStatementBalance(e.target.value); setResult(null) }}
            placeholder="0.00"
            className="w-full outline-none"
            style={inputStyle}
          />
        </div>
      </div>

      {account?.lastReconciledAt && (
        <p className="text-xs" style={{ color: 'var(--tx-faint)' }}>
          Last reconciled {new Date(account.lastReconciledAt).toLocaleDateString()}
          {account.lastReconciledBalance != null && ` · ${account.currency} ${fromCents(account.lastReconciledBalance).toFixed(2)}`}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button variant="default" size="sm" onClick={check} disabled={loading}>
          {loading ? 'Computing…' : 'Compute balance'}
        </Button>
        {result?.balanced && (
          <Button variant="primary" size="sm" onClick={commit} disabled={committing}>
            {committing ? 'Marking…' : 'Mark period reconciled'}
          </Button>
        )}
      </div>

      {result && account && (
        <div
          className="flex items-start gap-2.5 px-3 py-2.5 rounded-[6px] text-sm"
          style={{
            backgroundColor: result.balanced ? 'var(--bg-notify-success)' : 'var(--bg-notify-error)',
            color: result.balanced ? 'var(--tx-notify-success)' : 'var(--tx-notify-error)',
          }}
        >
          {result.balanced ? <CheckCircle2 size={16} className="mt-0.5 flex-shrink-0" /> : <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />}
          <div>
            <p className="font-medium">
              App balance: {account.currency} {fromCents(result.computedBalance).toFixed(2)}
            </p>
            {result.balanced ? (
              <p>Matches the statement balance exactly.</p>
            ) : (
              <p>
                Off by {account.currency} {fromCents(Math.abs(result.delta)).toFixed(2)}
                {result.delta > 0 ? ' (statement is higher)' : ' (statement is lower)'}.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
